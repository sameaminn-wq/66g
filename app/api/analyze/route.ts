// app/api/analyze/route.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error('GEMINI_API_KEY is missing in environment variables');
}

const genAI = new GoogleGenerativeAI(apiKey);

// -----------------------------
// Types
// -----------------------------
type ProductConfidence = 'high' | 'medium' | 'low';
type AnalysisQuality = 'excellent' | 'good' | 'partial' | 'failed';

interface ProductItem {
  product_name: string;
  brand: string;
  category: string;
  unit_price: string;
  quantity: number;
  barcode: string;
  confidence: ProductConfidence;
  notes: string;
}

interface AnalysisResponse {
  success: boolean;
  products: ProductItem[];
  total_products_detected: number;
  analysis_quality: AnalysisQuality;
  warnings: string[];
}

// -----------------------------
// Helpers
// -----------------------------
function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJson(text: string): any {
  if (!text) return null;

  // إزالة markdown code blocks
  const cleaned = text.replace(/```json|```/gi, '').trim();

  // محاولة مباشرة
  const direct = safeJsonParse(cleaned);
  if (direct) return direct;

  // استخراج أول JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    return safeJsonParse(match[0]);
  }

  return null;
}

function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 300);
}

function sanitizeProducts(items: any[]): ProductItem[] {
  if (!Array.isArray(items)) return [];

  return items.slice(0, 200).map((item) => ({
    product_name: sanitizeString(item?.product_name),
    brand: sanitizeString(item?.brand),
    category: sanitizeString(item?.category),
    unit_price: sanitizeString(item?.unit_price),
    quantity:
      typeof item?.quantity === 'number' && item.quantity > 0
        ? Math.floor(item.quantity)
        : 1,
    barcode: sanitizeString(item?.barcode),
    confidence: ['high', 'medium', 'low'].includes(item?.confidence)
      ? item.confidence
      : 'medium',
    notes: sanitizeString(item?.notes),
  }));
}

function buildResponse(data: any): AnalysisResponse {
  const products = sanitizeProducts(data?.products);

  return {
    success: true,
    products,
    total_products_detected: products.length,
    analysis_quality: ['excellent', 'good', 'partial', 'failed'].includes(
      data?.analysis_quality
    )
      ? data.analysis_quality
      : 'good',
    warnings: Array.isArray(data?.warnings)
      ? data.warnings.map((w: any) => sanitizeString(w)).slice(0, 20)
      : [],
  };
}

// -----------------------------
// API
// -----------------------------
export async function POST(req: Request) {
  try {
    // حماية نوع المحتوى
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json(
        { success: false, error: 'نوع البيانات غير مدعوم' },
        { status: 415 }
      );
    }

    const body = await req.json();
    const image = body?.image;

    if (!image || typeof image !== 'string') {
      return NextResponse.json(
        { success: false, error: 'الصورة مطلوبة' },
        { status: 400 }
      );
    }

    // التحقق من Base64
    if (!image.startsWith('data:image/')) {
      return NextResponse.json(
        { success: false, error: 'صيغة الصورة غير صحيحة' },
        { status: 400 }
      );
    }

    const mimeType = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1];

    if (!mimeType) {
      return NextResponse.json(
        { success: false, error: 'تعذر تحديد نوع الصورة' },
        { status: 400 }
      );
    }

    const base64Data = image.split(',')[1];

    if (!base64Data) {
      return NextResponse.json(
        { success: false, error: 'بيانات الصورة فارغة' },
        { status: 400 }
      );
    }

    // منع الصور الضخمة
    const approxSizeMB = (base64Data.length * 3) / 4 / 1024 / 1024;
    if (approxSizeMB > 15) {
      return NextResponse.json(
        { success: false, error: 'حجم الصورة كبير جداً' },
        { status: 413 }
      );
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 4096,
      },
    });

    const prompt = `
أنت نظام ذكاء اصطناعي متخصص في تحليل رفوف المتاجر.

المطلوب:
- اكتشف المنتجات الظاهرة في الصورة.
- استخرج فقط ما يمكن رؤيته بثقة.
- لا تخمن الباركود إذا لم يكن واضحاً.
- لا تخمن السعر إذا لم يكن ظاهر.
- إذا تكرر نفس المنتج عدة مرات اجمعه في quantity.

أعد الرد JSON فقط بدون أي شرح.

{
  "success": true,
  "products": [
    {
      "product_name": "",
      "brand": "",
      "category": "",
      "unit_price": "",
      "quantity": 1,
      "barcode": "",
      "confidence": "high",
      "notes": ""
    }
  ],
  "total_products_detected": 0,
  "analysis_quality": "excellent",
  "warnings": []
}
`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType,
        },
      },
    ]);

    const text = result.response.text();
    const parsed = extractJson(text);

    if (!parsed) {
      return NextResponse.json(
        {
          success: false,
          error: 'تعذر قراءة رد الذكاء الاصطناعي',
        },
        { status: 502 }
      );
    }

    const finalData = buildResponse(parsed);

    return NextResponse.json(finalData, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: any) {
    console.error('Gemini Analyze Error:', error);

    return NextResponse.json(
      {
        success: false,
        error: 'فشل تحليل الصورة',
        details:
          process.env.NODE_ENV === 'development'
            ? error?.message || 'Unknown error'
            : undefined,
      },
      { status: 500 }
    );
  }
}
