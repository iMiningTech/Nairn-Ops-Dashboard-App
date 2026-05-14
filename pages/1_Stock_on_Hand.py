import streamlit as st
import pandas as pd
import plotly.express as px
from datetime import datetime
from streamlit_autorefresh import st_autorefresh
from data.loader import load_inventory_master

st.set_page_config(
    page_title="Stock on Hand | Nairn Det Plant",
    page_icon="📦",
    layout="wide",
)

st_autorefresh(interval=60_000, key="stock_refresh")

# ── Header ────────────────────────────────────────────────────────────────────
st.title("📦 Stock on Hand")
st.caption(f"Live snapshot · refreshes every 60 s · {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

# ── Data load ─────────────────────────────────────────────────────────────────
with st.spinner("Loading inventory…"):
    try:
        inv = load_inventory_master()
    except Exception as e:
        st.error(f"Failed to load Inventory_Master: {e}")
        st.stop()

# ── Sidebar filters ───────────────────────────────────────────────────────────
with st.sidebar:
    st.header("Filters")

    all_types = sorted(inv["Type"].unique().tolist())
    sel_types = st.multiselect("Type", all_types, default=all_types)

    all_locations = sorted([l for l in inv["Current_Location"].unique() if l])
    sel_locations = st.multiselect("Location", all_locations, default=all_locations)

    all_statuses = sorted(inv["Status"].unique().tolist())
    sel_statuses = st.multiselect("Status", all_statuses, default=["Active"])

    search = st.text_input("Search (QR / Description)", "")

    st.divider()
    if st.button("🔄 Force Refresh"):
        st.cache_data.clear()
        st.rerun()

# ── Apply filters ─────────────────────────────────────────────────────────────
df = inv.copy()

if sel_types:
    df = df[df["Type"].isin(sel_types)]
if sel_locations:
    df = df[df["Current_Location"].isin(sel_locations)]
if sel_statuses:
    df = df[df["Status"].isin(sel_statuses)]
if search:
    mask = (
        df["QR"].astype(str).str.contains(search, case=False, na=False)
        | df["Description"].astype(str).str.contains(search, case=False, na=False)
    )
    df = df[mask]

# ── KPI cards ─────────────────────────────────────────────────────────────────
flagged = df[df["Current_Quantity"] < 0]
locations_used = int(df["Current_Location"].replace("", None).dropna().nunique())
last_update = df["Last_Updated_At"].max()

k1, k2, k3, k4, k5 = st.columns(5)
k1.metric("Items (filtered)", f"{len(df):,}")
k2.metric("Total Quantity", f"{int(df['Current_Quantity'].sum()):,}")
k3.metric("Locations", locations_used)
k4.metric(
    "Flagged (negative qty)",
    len(flagged),
    delta=f"⚠ {len(flagged)}" if len(flagged) else None,
    delta_color="inverse",
)
k5.metric(
    "Last Updated",
    last_update.strftime("%d %b  %H:%M") if pd.notna(last_update) else "—",
)

if len(flagged):
    st.error(f"⚠ **{len(flagged)} item(s) have negative quantities.** These are likely pool discrepancies.")

st.divider()

# ── Charts ────────────────────────────────────────────────────────────────────
ch1, ch2 = st.columns(2)

with ch1:
    type_counts = df.groupby("Type")["Current_Quantity"].sum().reset_index()
    type_counts.columns = ["Type", "Total Quantity"]
    fig_type = px.pie(
        type_counts,
        names="Type",
        values="Total Quantity",
        title="Total Quantity by Item Type",
        hole=0.45,
        color_discrete_sequence=px.colors.qualitative.Bold,
    )
    fig_type.update_layout(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#FAFAFA",
        legend=dict(orientation="h", yanchor="bottom", y=-0.3),
        margin=dict(t=40, b=0),
    )
    st.plotly_chart(fig_type, use_container_width=True)

with ch2:
    loc_df = (
        df[df["Current_Location"] != ""]
        .groupby("Current_Location")["Current_Quantity"]
        .sum()
        .reset_index()
        .sort_values("Current_Quantity", ascending=False)
        .head(12)
    )
    loc_df.columns = ["Location", "Total Quantity"]
    fig_loc = px.bar(
        loc_df,
        x="Total Quantity",
        y="Location",
        orientation="h",
        title="Total Quantity by Location (top 12)",
        color="Total Quantity",
        color_continuous_scale="Oranges",
    )
    fig_loc.update_layout(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color="#FAFAFA",
        coloraxis_showscale=False,
        yaxis=dict(autorange="reversed"),
        margin=dict(t=40, b=0),
    )
    st.plotly_chart(fig_loc, use_container_width=True)

st.divider()

# ── Data table ────────────────────────────────────────────────────────────────
st.subheader(f"Inventory Records ({len(df):,} rows)")

display_cols = [
    "QR", "Description", "Type", "Current_Quantity",
    "Current_Location", "Current_Sub_Location",
    "Status", "Last_Updated_At", "Last_Updated_By",
    "ProdDate_Formatted", "QC_Person", "ProdShift",
]
display_cols = [c for c in display_cols if c in df.columns]
display_df = df[display_cols].copy()

# Highlight rows with negative quantities
def _row_style(row):
    if row["Current_Quantity"] < 0:
        return ["background-color: #3d1515; color: #ff8080"] * len(row)
    return [""] * len(row)

styled = display_df.style.apply(_row_style, axis=1).format(
    {
        "Current_Quantity": "{:,.0f}",
        "Last_Updated_At": lambda v: v.strftime("%d %b %Y  %H:%M") if pd.notna(v) else "—",
        "ProdDate_Formatted": lambda v: v.strftime("%d %b %Y") if pd.notna(v) else "—",
    }
)

st.dataframe(
    styled,
    use_container_width=True,
    height=500,
    column_config={
        "QR": st.column_config.TextColumn("QR Code", width="medium"),
        "Description": st.column_config.TextColumn("Description", width="large"),
        "Type": st.column_config.TextColumn("Type", width="small"),
        "Current_Quantity": st.column_config.NumberColumn("Qty", format="%d"),
        "Current_Location": st.column_config.TextColumn("Location", width="medium"),
        "Current_Sub_Location": st.column_config.TextColumn("Sub-Location", width="medium"),
        "Status": st.column_config.TextColumn("Status", width="small"),
        "Last_Updated_At": st.column_config.TextColumn("Last Updated", width="medium"),
        "Last_Updated_By": st.column_config.TextColumn("Updated By", width="medium"),
        "ProdDate_Formatted": st.column_config.TextColumn("Prod Date", width="small"),
        "QC_Person": st.column_config.TextColumn("QC Person", width="medium"),
        "ProdShift": st.column_config.TextColumn("Shift", width="small"),
    },
)

# ── Export ────────────────────────────────────────────────────────────────────
csv = display_df.to_csv(index=False).encode("utf-8")
st.download_button(
    "⬇ Download filtered data (CSV)",
    csv,
    file_name=f"stock_on_hand_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
    mime="text/csv",
)
