import streamlit as st
import pandas as pd
from datetime import datetime, timedelta
from streamlit_autorefresh import st_autorefresh
from data.loader import load_inventory_master, load_ndt_batch_contents

st.set_page_config(
    page_title="Destruction Records | Nairn Det Plant",
    page_icon="💥",
    layout="wide",
)

st_autorefresh(interval=60_000, key="destruction_refresh")

st.title("💥 Destruction Records")
st.caption(f"NDT batch destruction log · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

# ── Load data ─────────────────────────────────────────────────────────────────
with st.spinner("Loading…"):
    try:
        inv = load_inventory_master()
        batch_contents = load_ndt_batch_contents()
    except Exception as e:
        st.error(f"Failed to load data: {e}")
        st.stop()

ndt_batches = inv[inv["Type"] == "NDT_BATCH"].copy()

# ── Sidebar filters ───────────────────────────────────────────────────────────
with st.sidebar:
    st.header("Filters")
    all_statuses = sorted(ndt_batches["Status"].unique().tolist()) if not ndt_batches.empty else []
    sel_statuses = st.multiselect("Batch Status", all_statuses, default=all_statuses)

    if "Destruction_Date" in ndt_batches.columns:
        ndt_batches["Destruction_Date"] = pd.to_datetime(ndt_batches["Destruction_Date"], errors="coerce")
        destroyed = ndt_batches[ndt_batches["Destruction_Date"].notna()]
        if not destroyed.empty:
            min_d = destroyed["Destruction_Date"].min().date()
            max_d = destroyed["Destruction_Date"].max().date()
            date_from = st.date_input("Destroyed from", value=min_d)
            date_to = st.date_input("Destroyed to", value=max_d)

    st.divider()
    if st.button("🔄 Force Refresh"):
        st.cache_data.clear()
        st.rerun()

# ── Apply filters ─────────────────────────────────────────────────────────────
df = ndt_batches.copy()
if sel_statuses:
    df = df[df["Status"].isin(sel_statuses)]

# ── KPI row ───────────────────────────────────────────────────────────────────
destroyed_df = df[df["Status"].str.lower().str.contains("destroy", na=False)]
k1, k2, k3 = st.columns(3)
k1.metric("Total NDT Batches", len(df))
k2.metric("Destroyed", len(destroyed_df))
k3.metric("Active / Pending", len(df) - len(destroyed_df))

st.divider()

# ── Batch table ───────────────────────────────────────────────────────────────
st.subheader("NDT Batches")
display_cols = [c for c in ["QR", "Description", "Status", "Current_Quantity", "Current_Location",
                             "Destruction_Date", "Last_Updated_By", "Last_Updated_At", "Notes"] if c in df.columns]
show_df = df[display_cols].copy()

def _batch_style(row):
    s = str(row.get("Status", "")).lower()
    if "destroy" in s:
        return ["background-color: #1a1a2e"] * len(row)
    return [""] * len(row)

styled = show_df.style.apply(_batch_style, axis=1)
st.dataframe(styled, use_container_width=True, height=400)

# ── Batch contents ────────────────────────────────────────────────────────────
if not batch_contents.empty:
    st.divider()
    st.subheader("Batch Contents (line items)")
    st.dataframe(batch_contents, use_container_width=True, height=300)

csv = show_df.to_csv(index=False).encode("utf-8")
st.download_button(
    "⬇ Download Destruction Report (CSV)",
    csv,
    file_name=f"destruction_records_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
    mime="text/csv",
)
