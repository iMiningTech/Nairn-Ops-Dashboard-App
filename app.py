import streamlit as st
import pandas as pd
from datetime import datetime
from streamlit_autorefresh import st_autorefresh
from data.loader import load_inventory_master

st.set_page_config(
    page_title="Nairn Det Plant | Dashboard",
    page_icon="💥",
    layout="wide",
    initial_sidebar_state="expanded",
)

st_autorefresh(interval=60_000, key="home_refresh")

st.title("💥 Nairn Det Plant — Operations Dashboard")
st.caption(f"Auto-refreshes every 60 s · Last load: {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

st.divider()

try:
    inv = load_inventory_master()

    active = inv[inv["Status"] == "Active"]
    pools = active[active["Type"] == "POOL"]
    flagged = pools[pools["Current_Quantity"] < 0]
    last_update = active["Last_Updated_At"].max()

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Active Inventory Items", f"{len(active):,}")
    c2.metric("Locations in Use", int(active["Current_Location"].replace("", None).dropna().nunique()))
    c3.metric(
        "Pool Discrepancies",
        len(flagged),
        delta=f"⚠ {len(flagged)} negative" if len(flagged) else None,
        delta_color="inverse",
    )
    c4.metric(
        "Last Inventory Update",
        last_update.strftime("%d %b  %H:%M") if pd.notna(last_update) else "—",
    )

    if len(flagged):
        st.error(
            f"⚠ **{len(flagged)} pool(s) have negative quantities** — check the Pool Dashboard.",
            icon="🚨",
        )

except Exception as e:
    st.error(f"Could not load inventory data: {e}")

st.divider()

st.markdown("""
### Dashboard Sections

| | Section | What it shows |
|---|---|---|
| 📦 | **Stock on Hand** | Current inventory levels — filter by type, location, status |
| 🏊 | **Pool Dashboard** | Live pool quantities with discrepancy flags — kitchen TV view |
| 📋 | **Movement History** | Full transaction audit log with correlation ID navigation |
| 💥 | **Destruction Records** | NDT batch destruction reports, exportable for compliance |
| ⚖️ | **Reconciliation** | Per-room in/out balance checks, flags mismatches |
| 👤 | **User Activity** | Per-user transaction counts, training issue detection |

Use the sidebar to navigate between sections.
""")
