import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import { NextResponse } from "next/server";

// ============================================================
// Types
// ============================================================
interface ProductItem {
  product_name: string;
  brand: string;
  category: string;
  unit_price: string;
  quantity: number | string;
  barcode: string;
  confidence: "high" | "medium" | "low";
  notes: string;
}

interface AnalysisResult {
  success: boolean;
  products: ProductItem[];
  total_products_detected: number;
  analysis_quality: "excellent" | "good" | "partial" | "failed";
  warnings: string[];
}

// ============================================================
// Config
// ============================================================
const MAX_IMAGE_SIZE_MB = 10;
const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// ✅ الموديل الصحيح — 1.5 أُغلق نهائياً، 2.5-flash هو الأفضل حالياً
const MODEL_NAME = "gemini-2.5-flash";

const MAX_RETRIES = 2;

// ============================================================
// Helpers
// ============================================================
function getImageMimeType(base64: string): string {
  const header = base64.substring(0, 30);
  if (header.includes("jpeg") || header.includes("jpg")) return "image/jpeg";
  if (header.includes("png")) return "image/png";
  if (header.includes("webp")) return "image/webp";
  if (header.includes("gif")) return "image/gif";
  return "image/jpeg";
}

function validateBase64Image(image: string): { valid: boolean; error?: string; mimeType?: string } {
  if (!image || typeof image !== "string") {
    return { valid: false, error: "الصورة غير موجودة أو بصيغة غير صحيحة" };
  }

  const isDataUrl = image.startsWith("data:");
  const base64Data = isDataUrl ? image.split(",")[1] : image;

  if (!base64Data) {
    return { valid: false, error: "لا يمكن استخراج بيانات الصورة" };
  }

  const sizeInBytes = (base64Data.length * 3) / 4;
  const sizeInMB = sizeInBytes / (1024 * 1024);

  if (sizeInMB > MAX_IMAGE_SIZE_MB) {
    return { valid: false, error: `حجم الصورة كبير جداً (${sizeInMB.toFixed(1)}MB). الحد الأقصى ${MAX_IMAGE_SIZE_MB}MB` };
  }

  const mimeType = isDataUrl ? image.split(";")[0].split(":")[1] : getImageMimeType(base64Data);

  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    return { valid: false, error: `نوع الصورة غير مدعوم: ${mimeType}` };
  }

  return { valid: true, mimeType };
}

function buildPrompt(): string {
  return `
أنت نظام ذكاء اصطناعي متخصص في تحليل صور مخازن البضائع والمنتجات التجارية.

## مهمتك:
حلل الصورة بدقة واستخرج كل المنتجات الظاهرة بوضوح.

## قواعد صارمة:
1. أعد فقط JSON نقي بدون أي نص إضافي أو markdown أو backticks
2. لا تضف أي مقدمة أو خاتمة أو شرح
3. إذا كانت الصورة ضبابية أو المعلومة غير واضحة، استخدم مستوى الثقة المناسب
4. لا تخترع معلومات - إذا لم تجد شيئاً اتركه فارغاً ""
5. الكميات يجب أن تكون أرقاماً وليس نصاً

## صيغة الاستجابة المطلوبة (JSON فقط):
{
  "products": [
    {
      "product_name": "الاسم الكامل للمنتج",
      "brand": "الماركة/العلامة التجارية",
      "category": "الفئة (مثال: مشروبات، معلبات، منظفات، حلويات...)",
      "unit_price": "السعر الرقمي فقط كما هو مكتوب بدون رمز العملة، أو ''",
      "quantity": 0,
      "barcode": "رقم الباركود إن كان واضحاً أو ''",
      "confidence": "high أو medium أو low",
      "notes": "أي ملاحظة مهمة عن المنتج أو سبب انخفاض الثقة"
    }
  ],
  "analysis_quality": "excellent أو good أو partial أو failed",
  "warnings": ["أي تحذيرات مهمة عن جودة التحليل"]
}

## مستويات الثقة:
- high: المعلومة واضحة ومقروءة بشكل كامل
- medium: المعلومة مرئية لكن ليست حادة تماماً
- low: تخمين مبني على السياق أو الشكل العام

ابدأ مباشرة بـ { ولا تكتب أي شيء قبلها.
  `.trim();
}

function parseAIResponse(text: string): { products: ProductItem[]; analysis_quality: string; warnings: string[] } {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("لم يتم العثور على JSON في الاستجابة");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  if (!parsed.products || !Array.isArray(parsed.products)) {
    throw new Error("بنية JSON غير صحيحة - يجب أن يحتوي على مصفوفة products");
  }

  const products: ProductItem[] = parsed.products.map((item: Partial<ProductItem>) => ({
    product_name: String(item.product_name || "").trim(),
    brand: String(item.brand || "").trim(),
    category: String(item.category || "").trim(),
    unit_price: String(item.unit_price || "").trim(),
    quantity: typeof item.quantity === "number" ? item.quantity : parseInt(String(item.quantity)) || 0,
    barcode: String(item.barcode || "").trim(),
    confidence: (["high", "medium", "low"].includes(item.confidence as string) ? item.confidence : "medium") as ProductItem["confidence"],
    notes: String(item.notes || "").trim(),
  }));

  return {
    products,
    analysis_quality: parsed.analysis_quality || "good",
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

async function analyzeWithRetry(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  prompt: string,
  imageData: string,
  mimeType: string,
  retries: number = MAX_RETRIES
): Promise<string> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: imageData,
            mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
          },
        },
      ]);

      const response = await result.response;

      if (response.promptFeedback?.blockReason) {
        throw new Error(`المحتوى محجوب: ${response.promptFeedback.blockReason}`);
      }

      const text = response.text();
      if (!text || text.trim().length === 0) {
        throw new Error("استجابة فارغة من النموذج");
      }

      return text;
    } catch (error) {
      const isLastAttempt = attempt === retries + 1;
      if (isLastAttempt) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error("فشل بعد جميع المحاولات");
}

// ============================================================
// Main Handler
// ============================================================
export async function POST(req: Request) {
  const startTime = Date.now();
  console.log("Key Check:", process.env.GEMINI_API_KEY?.substring(0, 5) + "****");

  try {
    let body: { image?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "طلب غير صالح - يجب إرسال JSON" },
        { status: 400 }
      );
    }

    const { image } = body;

    const validation = validateBase64Image(image || "");
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    const mimeType = validation.mimeType!;
    const base64Data = image!.includes(",") ? image!.split(",")[1] : image!;

    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is not set");
      return NextResponse.json(
        { success: false, error: "خطأ في إعداد الخادم" },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // ✅ بدون { apiVersion } — المكتبة تختار الإصدار الصحيح تلقائياً
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      ],
      generationConfig: {
        temperature: 0.1,
        topK: 32,
        topP: 0.95,
        maxOutputTokens: 8100,
      },
    });

    const rawText = await analyzeWithRetry(model, buildPrompt(), base64Data, mimeType);
    const parsed = parseAIResponse(rawText);

    const result: AnalysisResult = {
      success: true,
      products: parsed.products,
      total_products_detected: parsed.products.length,
      analysis_quality: parsed.analysis_quality as AnalysisResult["analysis_quality"],
      warnings: parsed.warnings,
    };

    const duration = Date.now() - startTime;
    console.log(`✅ Analysis completed in ${duration}ms | Products: ${result.total_products_detected}`);

    return NextResponse.json(result, {
      headers: {
        "X-Analysis-Duration-Ms": String(duration),
        "X-Products-Count": String(result.total_products_detected),
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : "خطأ غير معروف";
    console.error(`❌ Analysis failed after ${duration}ms:`, errorMessage);

    const isClientError = errorMessage.includes("غير صالح") || errorMessage.includes("غير صحيح");

    return NextResponse.json(
      {
        success: false,
        error: "فشل في تحليل الصورة",
        detail: errorMessage,
        products: [],
        total_products_detected: 0,
      },
      { status: isClientError ? 400 : 500 }
    );
  }
}
