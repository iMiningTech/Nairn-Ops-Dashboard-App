import streamlit as st
import pandas as pd
import plotly.express as px
from datetime import datetime, timedelta
from streamlit_autorefresh import st_autorefresh
from data.loader import load_transaction_log, load_user_management

st.set_page_config(
    page_title="User Activity | Nairn Det Plant",
    page_icon="👤",
    layout="wide",
)

st_autorefresh(interval=60_000, key="user_refresh")

st.title("👤 User Activity")
st.caption(f"Per-user transaction summary · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

# ── Load data ─────────────────────────────────────────────────────────────────
with st.spinner("Loading…"):
    try:
        txn = load_transaction_log()
        users = load_user_management()
    except Exception as e:
        st.error(f"Failed to load data: {e}")
        st.stop()

if txn.empty:
    st.info("No transaction data available.")
    st.stop()

# ── Detect columns ────────────────────────────────────────────────────────────
ts_col = next((c for c in ["Timestamp", "Created_At"] if c in txn.columns), None)
user_col = next((c for c in ["User", "Updated_By", "Last_Updated_By"] if c in txn.columns), None)
reason_col = next((c for c in ["Reason", "Transaction_Reason"] if c in txn.columns), None)

# ── Sidebar filters ───────────────────────────────────────────────────────────
with st.sidebar:
    st.header("Filters")
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
        df = txn[txn[ts_col] >= cutoff].copy()
    else:
        df = txn.copy()
        period = "All time"

    if user_col:
        all_users = sorted(df[user_col].dropna().unique().tolist())
        sel_users = st.multiselect("Filter by User", all_users)
        if sel_users:
            df = df[df[user_col].isin(sel_users)]

    st.divider()
    if st.button("🔄 Force Refresh"):
        st.cache_data.clear()
        st.rerun()

st.subheader(f"Activity — {period}")

if not user_col:
    st.info("No User column found in Transaction_Log. Column mapping will be confirmed once real transaction data is available.")
    st.dataframe(df.head(50), use_container_width=True)
    st.stop()

# ── KPI row ───────────────────────────────────────────────────────────────────
k1, k2, k3 = st.columns(3)
k1.metric("Total Transactions", f"{len(df):,}")
k2.metric("Active Users", df[user_col].nunique())
if ts_col and not df.empty:
    latest = df[ts_col].max()
    k3.metric("Latest Activity", latest.strftime("%d %b  %H:%M") if pd.notna(latest) else "—")

st.divider()

# ── Transactions per user bar chart ──────────────────────────────────────────
user_counts = df.groupby(user_col).size().reset_index(name="Transactions")
user_counts = user_counts.sort_values("Transactions", ascending=False)

fig = px.bar(
    user_counts,
    x=user_col,
    y="Transactions",
    title=f"Transactions per User — {period}",
    color="Transactions",
    color_continuous_scale="Oranges",
    text="Transactions",
)
fig.update_traces(textposition="outside")
fig.update_layout(
    paper_bgcolor="rgba(0,0,0,0)",
    plot_bgcolor="rgba(0,0,0,0)",
    font_color="#FAFAFA",
    coloraxis_showscale=False,
    margin=dict(t=50, b=0),
)
st.plotly_chart(fig, use_container_width=True)

# ── Reason breakdown ──────────────────────────────────────────────────────────
if reason_col:
    st.divider()
    st.subheader("Reason Usage (training check)")
    st.caption("Users who rely heavily on 'Stock Correction' may not understand the reason list.")

    reason_by_user = (
        df.groupby([user_col, reason_col])
        .size()
        .reset_index(name="Count")
        .sort_values([user_col, "Count"], ascending=[True, False])
    )
    fig2 = px.bar(
        reason_by_user,
        x=user_col,
        y="Count",
        color=reason_col,
        title="Reason Breakdown per User",
        barmode="stack",
    )
    fig2.update_layout(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#FAFAFA",
        margin=dict(t=50, b=0),
    )
    st.plotly_chart(fig2, use_container_width=True)

# ── Detail table ──────────────────────────────────────────────────────────────
st.divider()
st.subheader("Transaction Detail")
st.dataframe(df, use_container_width=True, height=400)
