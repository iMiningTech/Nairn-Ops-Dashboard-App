import streamlit as st
import pandas as pd
import plotly.express as px
from datetime import datetime
from streamlit_autorefresh import st_autorefresh
from data.loader import load_inventory_master

st.set_page_config(
    page_title="Pool Dashboard | Nairn Det Plant",
    page_icon="🏊",
    layout="wide",
)

# Kitchen TV: refresh every 60 s, no sidebar clutter
st_autorefresh(interval=60_000, key="pool_refresh")

st.title("🏊 Pool Dashboard")
st.caption(f"Live · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

with st.spinner("Loading…"):
    try:
        inv = load_inventory_master()
    except Exception as e:
        st.error(f"Failed to load data: {e}")
        st.stop()

pools = inv[inv["Type"] == "POOL"].copy()
negative = pools[pools["Current_Quantity"] < 0]

# ── Top-level alert ───────────────────────────────────────────────────────────
if len(negative):
    st.error(
        f"🚨  **{len(negative)} POOL(S) WITH NEGATIVE QUANTITY — DISCREPANCY FLAG**",
        icon="🚨",
    )
else:
    st.success("✅  All pools balanced — no discrepancies detected.")

st.divider()

# ── KPI row ───────────────────────────────────────────────────────────────────
k1, k2, k3, k4 = st.columns(4)
k1.metric("Total Pools", len(pools))
k2.metric("Total Pool Quantity", f"{int(pools['Current_Quantity'].sum()):,}")
k3.metric("Pools with Stock", int((pools["Current_Quantity"] > 0).sum()))
k4.metric("Discrepancies (negative)", len(negative), delta=f"⚠ {len(negative)}" if len(negative) else None, delta_color="inverse")

st.divider()

# ── Pool quantity bar chart ───────────────────────────────────────────────────
if not pools.empty:
    chart_df = pools[["Description", "Current_Quantity", "Current_Location"]].copy()
    chart_df = chart_df.sort_values("Current_Quantity", ascending=True)
    chart_df["colour"] = chart_df["Current_Quantity"].apply(
        lambda q: "#FF4444" if q < 0 else "#ffb964" if q == 0 else "#f5911e"
    )

    fig = px.bar(
        chart_df,
        x="Current_Quantity",
        y="Description",
        orientation="h",
        title="Current Pool Quantities",
        color="colour",
        color_discrete_map="identity",
        text="Current_Quantity",
    )
    fig.update_traces(textposition="outside")
    fig.update_layout(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#FAFAFA",
        font_size=14,
        showlegend=False,
        yaxis=dict(autorange="reversed"),
        height=max(300, len(chart_df) * 40),
        margin=dict(t=50, b=20, l=200, r=80),
    )
    st.plotly_chart(fig, use_container_width=True)
else:
    st.info("No POOL type items found in Inventory_Master.")

st.divider()

# ── Pool detail table ─────────────────────────────────────────────────────────
st.subheader("Pool Details")

display_cols = [c for c in ["QR", "Description", "Current_Quantity", "Current_Location", "Current_Sub_Location", "Status", "Last_Updated_At", "Last_Updated_By"] if c in pools.columns]
show_df = pools[display_cols].copy()

def _pool_style(row):
    if row["Current_Quantity"] < 0:
        return ["background-color: #3d1515; color: #ff8080"] * len(row)
    if row["Current_Quantity"] == 0:
        return ["background-color: #2a2a1a"] * len(row)
    return [""] * len(row)

styled = show_df.style.apply(_pool_style, axis=1).format(
    {
        "Current_Quantity": "{:,.0f}",
        "Last_Updated_At": lambda v: v.strftime("%d %b  %H:%M") if pd.notna(v) else "—",
    }
)

st.dataframe(styled, use_container_width=True, height=400)
