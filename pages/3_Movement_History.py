import streamlit as st
import pandas as pd
from datetime import datetime, timedelta
from streamlit_autorefresh import st_autorefresh
from data.loader import load_transaction_log

st.set_page_config(
    page_title="Movement History | Nairn Det Plant",
    page_icon="📋",
    layout="wide",
)

st_autorefresh(interval=60_000, key="movement_refresh")

st.title("📋 Movement History")
st.caption(f"Full transaction audit log · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

# ── Load data ─────────────────────────────────────────────────────────────────
with st.spinner("Loading transaction log…"):
    try:
        txn = load_transaction_log()
    except Exception as e:
        st.error(f"Failed to load Transaction_Log: {e}")
        st.stop()

if txn.empty:
    st.info("No transaction records found.")
    st.stop()

# ── Detect timestamp column ───────────────────────────────────────────────────
ts_col = next((c for c in ["Timestamp", "Created_At", "Last_Updated_At"] if c in txn.columns), None)

# ── Sidebar filters ───────────────────────────────────────────────────────────
with st.sidebar:
    st.header("Filters")

    if ts_col:
        min_dt = txn[ts_col].min()
        max_dt = txn[ts_col].max()
        default_from = (max_dt - timedelta(days=7)).date() if pd.notna(max_dt) else (datetime.today() - timedelta(days=7)).date()
        date_from = st.date_input("From", value=default_from)
        date_to = st.date_input("To", value=max_dt.date() if pd.notna(max_dt) else datetime.today().date())

    search_qr = st.text_input("Search QR / Item")

    for col_label, col_name in [("User", "User"), ("Reason", "Reason"), ("Location", "Location")]:
        if col_name in txn.columns:
            opts = sorted(txn[col_name].dropna().unique().tolist())
            sel = st.multiselect(col_label, opts)
            if sel:
                txn = txn[txn[col_name].isin(sel)]

    st.divider()
    if st.button("🔄 Force Refresh"):
        st.cache_data.clear()
        st.rerun()

# ── Apply filters ─────────────────────────────────────────────────────────────
df = txn.copy()

if ts_col and "date_from" in dir():
    df = df[
        (df[ts_col].dt.date >= date_from) & (df[ts_col].dt.date <= date_to)
    ]

if search_qr:
    qr_cols = [c for c in df.columns if "QR" in c or "Item" in c]
    if qr_cols:
        mask = pd.Series(False, index=df.index)
        for c in qr_cols:
            mask |= df[c].astype(str).str.contains(search_qr, case=False, na=False)
        df = df[mask]

# ── KPI row ───────────────────────────────────────────────────────────────────
k1, k2, k3 = st.columns(3)
k1.metric("Transactions (filtered)", f"{len(df):,}")
if "User" in df.columns:
    k2.metric("Unique Users", df["User"].nunique())
if ts_col and not df.empty:
    latest = df[ts_col].max()
    k3.metric("Latest Transaction", latest.strftime("%d %b  %H:%M") if pd.notna(latest) else "—")

st.divider()

# ── Table ─────────────────────────────────────────────────────────────────────
st.subheader(f"Transactions ({len(df):,})")

# Show all available columns but put the important ones first
priority = [ts_col, "User", "Reason", "QR", "Description", "Quantity_Change",
            "Location", "From_Location", "To_Location", "Correlation_ID", "Notes"]
ordered = [c for c in priority if c and c in df.columns]
rest = [c for c in df.columns if c not in ordered]
df = df[ordered + rest]

st.dataframe(df, use_container_width=True, height=600)

csv = df.to_csv(index=False).encode("utf-8")
st.download_button(
    "⬇ Download (CSV)",
    csv,
    file_name=f"movement_history_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
    mime="text/csv",
)
