import pandas as pd
import streamlit as st
from urllib.parse import quote

SHEET_ID = "15eiq1d-w5av0JIf1u_x4kPAhUiDU_wJIMd3JgmQOxPM"


def _url(tab_name: str) -> str:
    return (
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        f"/gviz/tq?tqx=out:csv&sheet={quote(tab_name)}"
    )


@st.cache_data(ttl=60, show_spinner=False)
def load_inventory_master() -> pd.DataFrame:
    df = pd.read_csv(_url("Inventory_Master"))
    df["Current_Quantity"] = pd.to_numeric(df["Current_Quantity"], errors="coerce").fillna(0)
    df["Original_Quantity"] = pd.to_numeric(df["Original_Quantity"], errors="coerce").fillna(0)
    df["Last_Updated_At"] = pd.to_datetime(df["Last_Updated_At"], errors="coerce")
    df["First_Seen_At"] = pd.to_datetime(df["First_Seen_At"], errors="coerce")
    df["ProdDate_Formatted"] = pd.to_datetime(df["ProdDate_Formatted"], errors="coerce")
    df["Current_Location"] = df["Current_Location"].fillna("").astype(str)
    df["Current_Sub_Location"] = df["Current_Sub_Location"].fillna("").astype(str)
    df["Status"] = df["Status"].fillna("Unknown").astype(str)
    df["Type"] = df["Type"].fillna("Unknown").astype(str)
    return df


@st.cache_data(ttl=60, show_spinner=False)
def load_transaction_log() -> pd.DataFrame:
    df = pd.read_csv(_url("Transaction_Log"))
    for col in ["Timestamp", "Created_At"]:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    if "Quantity_Change" in df.columns:
        df["Quantity_Change"] = pd.to_numeric(df["Quantity_Change"], errors="coerce")
    return df


@st.cache_data(ttl=60, show_spinner=False)
def load_ndt_batch_contents() -> pd.DataFrame:
    df = pd.read_csv(_url("NDT_Batch_Contents"))
    for col in ["Destruction_Date", "Created_At"]:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


@st.cache_data(ttl=60, show_spinner=False)
def load_user_management() -> pd.DataFrame:
    return pd.read_csv(_url("User_Management"))


@st.cache_data(ttl=60, show_spinner=False)
def load_locations() -> pd.DataFrame:
    return pd.read_csv(_url("Locations"))


@st.cache_data(ttl=60, show_spinner=False)
def load_reasons() -> pd.DataFrame:
    return pd.read_csv(_url("Reasons"))


@st.cache_data(ttl=60, show_spinner=False)
def load_pool_trigger_locations() -> pd.DataFrame:
    return pd.read_csv(_url("Pool_Trigger_Locations"))


@st.cache_data(ttl=60, show_spinner=False)
def load_assembly_recipes() -> pd.DataFrame:
    return pd.read_csv(_url("Assembly_Recipes"))


@st.cache_data(ttl=60, show_spinner=False)
def load_ndt_item_types() -> pd.DataFrame:
    return pd.read_csv(_url("NDT_Item_Types"))
