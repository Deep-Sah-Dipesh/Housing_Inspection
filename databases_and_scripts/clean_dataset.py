import pandas as pd

def generate_clean_database():
    file_path = "BLG BF Detail TPQMA - No Duplicates.xlsx"
    print(f"Loading {file_path}...")
    
    # 1. Load the raw Excel dataset
    df = pd.read_excel(file_path)
    original_count = len(df)
    
    # 2. Sort by BeneficiaryID, and then by Sr.No descending. 
    # This ensures that for any duplicate BeneficiaryID, the row with the HIGHEST Sr.No comes first.
    df = df.sort_values(by=['BeneficiaryID', 'Sr.No'], ascending=[True, False])
    
    # 3. Drop duplicates based on BeneficiaryID, keeping only the first occurrence (the latest Sr.No)
    df_clean = df.drop_duplicates(subset=['BeneficiaryID'], keep='first')
    
    final_count = len(df_clean)
    print(f"Original Rows: {original_count}")
    print(f"Duplicates Removed: {original_count - final_count}")
    print(f"Unique Beneficiaries Remaining: {final_count}") # Will output 9848
    
    # 4. Map the cleaned data to your exact React Native SQLite schema
    mapped_df = pd.DataFrame({
        "code": df_clean["BeneficiaryID"].astype(str),
        "name": df_clean["BeneficiaryName"].astype(str),
        "serial_number": df_clean["Sr.No"].astype(str),
        "district_name": df_clean["District_Name"].astype(str),
        "city_name": df_clean["City_Name"].astype(str),
        "annexure_id": df_clean["Annexure_Id"].astype(str),
        "father_name": df_clean["BeneficiaryFatherName"].astype(str),
        "project_name": df_clean["ProjectName"].astype(str),
        "site_address": df_clean["ConstructionSiteAddress"].astype(str)
    })
    
    # 5. Clean up missing data artifacts (preventing stringified 'nan')
    mapped_df = mapped_df.replace({'nan': '', 'NaN': '', 'None': ''})
    
    # 6. Export as JSON for the React Native app to consume natively
    output_file = "beneficiaries_seed.json"
    mapped_df.to_json(output_file, orient="records")
    print(f"Success! Cleaned database saved to {output_file}")

if __name__ == "__main__":
    generate_clean_database()