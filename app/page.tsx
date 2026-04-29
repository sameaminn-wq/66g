"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ============================================================
// الأنواع (Types)
// ============================================================
type Confidence = "high" | "medium" | "low";
type AnalysisQuality = "excellent" | "good" | "partial" | "failed";

interface ProductItem {
  product_name: string;
  brand: string;
  category: string;
  unit_price: string;
  quantity: number | string;
  barcode: string;
  confidence: Confidence;
  notes: string;
}

interface AnalysisResult {
  success: boolean;
  products: ProductItem[];
  total_products_detected: number;
  analysis_quality: AnalysisQuality;
  warnings: string[];
}

interface Currency {
  code: string;
  symbol: string;
  name: string;
  flag: string;
}

interface InvoiceInfo {
  clientName: string;
  clientPhone: string;
  clientAddress: string;
  companyName: string;
  companyLogo: string;
  invoiceNumber: string;
  invoiceDate: string;
  notes: string;
  taxPercent: number;
  discountPercent: number;
  showBarcode: boolean;
}

// ============================================================
// الثوابت (Constants)
// ============================================================
const CURRENCIES: Currency[] = [
  { code: "EGP", symbol: "ج.م", name: "جنيه مصري", flag: "🇪🇬" },
  { code: "SAR", symbol: "ر.س", name: "ريال سعودي", flag: "🇸🇦" },
  { code: "AED", symbol: "د.إ", name: "درهم إماراتي", flag: "🇦🇪" },
  { code: "KWD", symbol: "د.ك", name: "دينار كويتي", flag: "🇰🇼" },
  { code: "USD", symbol: "$", name: "دولار أمريكي", flag: "🇺🇸" },
];

const LIGHTING_MODES = [
  { id: "auto", label: "تلقائي", icon: "✨", filter: "none", desc: "للإضاءة الطبيعية" },
  { id: "bright", label: "إضاءة عالية", icon: "☀️", filter: "brightness(0.65) contrast(1.2)", desc: "للأماكن الساطعة" },
  { id: "dark", label: "إضاءة خافتة", icon: "🌙", filter: "brightness(1.7) contrast(1.25)", desc: "للمخازن المظلمة" },
  { id: "sharp", label: "تعزيز الحدة", icon: "🔍", filter: "contrast(1.4) saturate(1.35)", desc: "لوضوح الباركود" },
];

// ============================================================
// المكونات الفرعية (Sub-components)
// ============================================================

function ConfidenceBadge({ level }: { level: Confidence }) {
  const map: Record<Confidence, { label: string; class: string }> = {
    high: { label: "دقة عالية", class: "badge-success" },
    medium: { label: "دقة متوسطة", class: "badge-warning" },
    low: { label: "دقة منخفضة", class: "badge-danger" },
  };
  const { label, class: cls } = map[level] ?? map.medium;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function QualityBar({ quality }: { quality: AnalysisQuality }) {
  const map: Record<AnalysisQuality, { label: string; width: string; color: string }> = {
    excellent: { label: "ممتاز", width: "100%", color: "#10b981" },
    good: { label: "جيد", width: "75%", color: "#3b82f6" },
    partial: { label: "جزئي", width: "45%", color: "#f59e0b" },
    failed: { label: "فشل", width: "10%", color: "#ef4444" },
  };
  const { label, width, color } = map[quality] ?? map.good;
  return (
    <div className="quality-bar-wrapper">
      <span className="quality-label">جودة التحليل: {label}</span>
      <div className="quality-track">
        <div className="quality-fill" style={{ width, background: color }} />
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  return (
    <div className="stat-card">
      <span className="stat-icon">{icon}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ProductCard({ item, index, onChange, onDelete, currencySymbol }: any) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="product-card">
      <div className="product-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="product-card-left">
          <div className="product-index">#{index + 1}</div>
          <div>
            <div className="product-name">{item.product_name || "منتج غير معروف"}</div>
            <div className="product-meta">
              {item.brand && <span className="chip chip-brand">{item.brand}</span>}
              {item.category && <span className="chip chip-cat">{item.category}</span>}
            </div>
          </div>
        </div>
        <div className="product-card-right">
          <ConfidenceBadge level={item.confidence} />
          <span className="expand-icon">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>
      <div className="product-quick-stats">
        <div className="quick-stat"><span className="qs-label">الكمية</span><span className="qs-value">{item.quantity}</span></div>
        <div className="quick-stat"><span className="qs-label">السعر</span><span className="qs-value">{item.unit_price} {currencySymbol}</span></div>
      </div>
      {expanded && (
        <div className="product-edit-section">
          <div className="edit-grid">
            {["product_name", "brand", "category", "unit_price", "quantity", "barcode"].map((field) => (
              <div key={field} className="edit-field">
                <label className="edit-label">{field}</label>
                <input className="edit-input" value={item[field]} onChange={(e) => onChange(index, field, e.target.value)} />
              </div>
            ))}
          </div>
          <button className="delete-btn" onClick={() => onDelete(index)}>حذف المنتج</button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// المكون الرئيسي (Main Page Component)
// ============================================================
export default function InventoryApp() {
  const [isMounted, setIsMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [currency, setCurrency] = useState<Currency>(CURRENCIES[0]);
  const [showSettings, setShowSettings] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    const savedId = localStorage.getItem("inv_spreadsheet_id");
    if (savedId) setSpreadsheetId(savedId);
  }, []);

  const handleCapture = useCallback(async (imageData: string) => {
    setPreviewImg(imageData);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "فشل التحليل");
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleReset = () => {
    setResult(null);
    setPreviewImg(null);
    setError(null);
    setExportSuccess(false);
  };

  const handleFieldChange = (idx: number, field: string, value: string) => {
    setResult((prev: any) => {
      const updated = [...prev.products];
      updated[idx] = { ...updated[idx], [field]: value };
      return { ...prev, products: updated };
    });
  };

  const handleDelete = (idx: number) => {
    setResult((prev: any) => ({
      ...prev,
      products: prev.products.filter((_: any, i: number) => i !== idx),
    }));
  };

  if (!isMounted) return null;

  const highConfidence = result?.products?.filter((p) => p.confidence === "high").length ?? 0;

  return (
    <div className="scanner-root">
      <style>{`
        body { background: #0a0e1a; direction: rtl; font-family: sans-serif; color: #e2e8f0; margin: 0; }
        .header { background: #0f172a; padding: 1rem 1.5rem; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
        .main { max-width: 800px; margin: 0 auto; padding: 1.5rem; }
        .capture-zone { border: 2px dashed #334155; border-radius: 20px; padding: 3rem; text-align: center; background: #0f172a; }
        .product-card { background: #0f172a; border-radius: 12px; margin-bottom: 1rem; border: 1px solid #1e293b; overflow: hidden; }
        .product-card-header { padding: 1rem; display: flex; justify-content: space-between; cursor: pointer; }
        .stats-bar { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
        .stat-card { background: #0f172a; padding: 1rem; border-radius: 12px; text-align: center; border: 1px solid #1e293b; }
        .btn { padding: 0.75rem 1.5rem; border-radius: 10px; border: none; cursor: pointer; font-weight: bold; transition: 0.2s; }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-export { background: #10b981; color: white; width: 100%; margin-top: 1rem; }
        .image-preview img { width: 100%; border-radius: 12px; margin-bottom: 1rem; }
        .badge { font-size: 0.7rem; padding: 3px 8px; border-radius: 5px; }
        .badge-success { background: rgba(16,185,129,0.2); color: #10b981; }
        .chip { font-size: 0.7rem; background: #1e293b; padding: 2px 6px; border-radius: 4px; margin-left: 4px; }
        .edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; padding: 1rem; background: #070b14; }
        .edit-input { background: #1e293b; border: 1px solid #334155; color: white; padding: 5px; border-radius: 5px; }
      `}</style>

      <header className="header">
        <div className="header-brand">
          <span style={{fontSize: '1.5rem'}}>🏪</span>
          <div style={{marginRight: '10px'}}>
            <div style={{fontWeight: 'bold'}}>الماسح الذكي للمخزون</div>
            <div style={{fontSize: '0.7rem', color: '#64748b'}}>Smart Inventory AI</div>
          </div>
        </div>
        <button className="btn btn-secondary" onClick={() => setShowSettings(true)}>⚙️</button>
      </header>

      <main className="main">
        {previewImg && (
          <div className="image-preview">
            <img src={previewImg} alt="Preview" />
          </div>
        )}

        {!result && !loading && (
          <div className="capture-zone">
            <div style={{fontSize: '3rem', marginBottom: '1rem'}}>📸</div>
            <h3>التقط صورة للرفوف لبدء الجرد</h3>
            <p style={{color: '#64748b', marginBottom: '2rem'}}>يدعم جميع أنواع المنتجات والباركود</p>
            <input type="file" accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => handleCapture(ev.target?.result as string);
                reader.readAsDataURL(file);
              }
            }} />
          </div>
        )}

        {loading && (
          <div style={{textAlign: 'center', padding: '3rem'}}>
            <div style={{fontSize: '2rem', animation: 'spin 1s infinite'}}>⏳</div>
            <p>جاري تحليل الرفوف بالذكاء الاصطناعي...</p>
          </div>
        )}

        {result && (
          <>
            <div className="stats-bar">
              <StatCard label="المنتجات" value={result.products.length} icon="📦" />
              <StatCard label="دقة عالية" value={highConfidence} icon="✅" />
              <StatCard label="فئات" value={new Set(result.products.map(p => p.category)).size} icon="🏷️" />
            </div>

            <QualityBar quality={result.analysis_quality} />

            <div className="products-list">
              {result.products.map((item, idx) => (
                <ProductCard 
                  key={idx} 
                  item={item} 
                  index={idx} 
                  onChange={handleFieldChange} 
                  onDelete={handleDelete}
                  currencySymbol={currency.symbol}
                />
              ))}
            </div>

            <button className="btn btn-export" onClick={() => alert('جاري التصدير...')}>
              📊 تصدير إلى Google Sheets
            </button>
            
            <button className="btn btn-primary" style={{width: '100%', marginTop: '0.5rem'}} onClick={() => alert('فتح الفاتورة...')}>
              🧾 إنشاء فاتورة PDF
            </button>

            <button className="btn btn-secondary" style={{width: '100%', marginTop: '0.5rem'}} onClick={handleReset}>
              🔄 إعادة جرد صورة جديدة
            </button>
          </>
        )}
      </main>
    </div>
  );
}