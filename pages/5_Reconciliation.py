import streamlit as st
import pandas as pd
from datetime import datetime
from streamlit_autorefresh import st_autorefresh
from data.loader import load_inventory_master, load_transaction_log

st.set_page_config(
    page_title="Reconciliation | Nairn Det Plant",
    page_icon="⚖️",
    layout="wide",
)

st_autorefresh(interval=60_000, key="recon_refresh")

st.title("⚖️ Reconciliation")
st.caption(f"Per-room balance check · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

st.info(
    "**Reconciliation** compares calculated in/out totals from the transaction log "
    "against current pool quantities. A mismatch means unscanned or mis-logged movements.",
    icon="ℹ️",
)

# ── Load data ─────────────────────────────────────────────────────────────────
with st.spinner("Loading…"):
    try:
        inv = load_inventory_master()
        txn = load_transaction_log()
    except Exception as e:
        st.error(f"Failed to load data: {e}")
        st.stop()

pools = inv[inv["Type"] == "POOL"].copy()

# ── Date range filter ─────────────────────────────────────────────────────────
with st.sidebar:
    st.header("Filters")
    ts_col = next((c for c in ["Timestamp", "Created_At"] if c in txn.columns), None)
    if ts_col:
        period = st.selectbox("Period", ["Today", "This week", "This month", "All time"], index=1)
        now = pd.Timestamp.now()
        if period == "Today":
            cutoff = now.normalize()
        elif period == "This week":
            cutoff = now - pd.Timedelta(days=now.dayofweek)
            cutoff = cutoff.normalize()
        elif period == "This month":
            cutoff = now.replace(day=1).normalize()
        else:
            cutoff = pd.Timestamp("2000-01-01")
        txn_period = txn[txn[ts_col] >= cutoff].copy()
    else:
        txn_period = txn.copy()

    st.divider()
    if st.button("🔄 Force Refresh"):
        st.cache_data.clear()
        st.rerun()

# ── Pool balance table ────────────────────────────────────────────────────────
st.subheader("Pool Balances")

if pools.empty:
    st.info("No POOL items found.")
else:
    neg = pools[pools["Current_Quantity"] < 0]
    if len(neg):
        st.error(f"🚨 {len(neg)} pool(s) with negative quantity detected.")
    else:
        st.success("All pools show non-negative quantities.")

    display_cols = [c for c in ["Description", "Current_Quantity", "Current_Location", "Last_Updated_At", "Last_Updated_By"] if c in pools.columns]
    pool_show = pools[display_cols].copy()

    def _pool_style(row):
        if row.get("Current_Quantity", 0) < 0:
            return ["background-color: #3d1515; color: #ff8080"] * len(row)
        return [""] * len(row)

    st.dataframe(pool_show.style.apply(_pool_style, axis=1), use_container_width=True, height=300)

st.divider()

# ── Transaction summary by location ──────────────────────────────────────────
st.subheader(f"Transaction Summary — {period if ts_col else 'All time'}")

if txn_period.empty:
    st.info("No transactions in selected period.")
else:
    loc_col = next((c for c in ["Location", "From_Location", "To_Location"] if c in txn_period.columns), None)
    qty_col = next((c for c in ["Quantity_Change", "Quantity"] if c in txn_period.columns), None)

    if loc_col and qty_col:
        summary = (
            txn_period.groupby(loc_col)[qty_col]
            .agg(["sum", "count"])
            .reset_index()
        )
        summary.columns = ["Location", "Net Qty Change", "Transaction Count"]
        summary = summary.sort_values("Net Qty Change")
        st.dataframe(summary, use_container_width=True)
    else:
        st.info("Transaction log does not contain the expected Location/Quantity columns yet. "
                "This view will populate automatically once the column mapping is confirmed.")
        st.dataframe(txn_period.head(50), use_container_width=True)
