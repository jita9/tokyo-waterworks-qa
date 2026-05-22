import os
import sys
import json
import requests
from pypdf import PdfReader

# List of documents to download and extract
DOCUMENTS = [
    {
        "id": "cover",
        "title": "表紙・はじめに",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-02_r0804"
    },
    {
        "id": "toc",
        "title": "目次",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-03_r0804"
    },
    {
        "id": "chapter-1",
        "title": "第１章 水道",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-04_r0804"
    },
    {
        "id": "chapter-2",
        "title": "第２章 指定給水装置工事事業者",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-05_r0804"
    },
    {
        "id": "chapter-3",
        "title": "第３章 手続",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-06_r0804"
    },
    {
        "id": "standards",
        "title": "給水装置設計・施工基準（給水装置編）",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-07_r0804"
    },
    {
        "id": "examples",
        "title": "様式記入例・作成例",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-08_r0804"
    },
    {
        "id": "laws",
        "title": "関係法令（抜粋）",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-09_r0804"
    },
    {
        "id": "offices",
        "title": "所管事業所一覧",
        "url": "https://www.waterworks.metro.tokyo.lg.jp/documents/d/waterworks/106023027007-10_r0804"
    }
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def download_pdf(url, output_path):
    print(f"Downloading {url}...")
    response = requests.get(url, headers=HEADERS, stream=True)
    if response.status_code == 200:
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"Saved to {output_path}")
        return True
    else:
        print(f"Failed to download {url}: HTTP {response.status_code}")
        return False

def extract_text_from_pdf(pdf_path):
    print(f"Extracting text from {pdf_path}...")
    pages = []
    try:
        reader = PdfReader(pdf_path)
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                # Clean up text a bit (remove null bytes, normalize whitespaces)
                text = text.replace('\x00', '')
                pages.append({
                    "page_number": i + 1,
                    "text": text.strip()
                })
    except Exception as e:
        print(f"Error reading PDF {pdf_path}: {e}")
    return pages

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    output_dir = os.path.join(project_dir, "src", "data")
    temp_dir = os.path.join(project_dir, "temp_pdfs")
    
    os.makedirs(temp_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)
    
    result = []
    
    for doc in DOCUMENTS:
        pdf_filename = f"{doc['id']}.pdf"
        pdf_path = os.path.join(temp_dir, pdf_filename)
        
        # Download the file
        success = download_pdf(doc["url"], pdf_path)
        if not success:
            print(f"Skipping {doc['title']} due to download failure.")
            continue
            
        # Extract text page-by-page
        pages = extract_text_from_pdf(pdf_path)
        
        doc_data = {
            "id": doc["id"],
            "title": doc["title"],
            "url": doc["url"],
            "pages": pages,
            "total_pages": len(pages),
            "file_size": f"{os.path.getsize(pdf_path) / 1024:.1f} KB"
        }
        result.append(doc_data)
        
    output_json_path = os.path.join(output_dir, "specifications.json")
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        
    print(f"\nSuccessfully extracted all documents!")
    print(f"Saved database JSON to: {output_json_path}")
    
    # Clean up temp PDFs to save space
    print("Cleaning up temporary PDF downloads...")
    for doc in DOCUMENTS:
        pdf_path = os.path.join(temp_dir, f"{doc['id']}.pdf")
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
    if os.path.exists(temp_dir):
        os.rmdir(temp_dir)
    print("Done!")

if __name__ == "__main__":
    main()
