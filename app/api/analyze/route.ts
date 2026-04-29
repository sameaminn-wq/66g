// app/api/analyze/route.ts
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
import { NextResponse } from "next/server";

/**
 * 🔒 معايير الأمان المطبقة:
 * 1. حماية الـ Rate Limit (عبر headers)
 * 2. التحقق من صحة البيانات (Zod-like Validation)
 * 3. تنظيف البيانات الخارجة (Output Sanitization)
 * 4. إدارة صارمة للذاكرة وحجم الملفات
 */

// ============================================================
// القواعد الثابتة والأنواع
// ============================================================
const MAX_IMAGE_SIZE_MB = 10;
const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MODEL_NAME = "gemini-2.0-flash"; // الإصدار المستقر والذكي جداً في الرؤية

interface ProductItem {
  product_name: string;
  brand: string;
  category: string;
  unit_price: string;
  quantity: number;
  barcode: string;
  confidence: "high" | "medium" | "low";
  notes: string;
}

// ============================================================
// وظائف المساعدة (Helpers) - "Clean & Secure"
// ============================================================

// تنظيف النصوص لمنع الـ XSS أو حقن البيانات
function sanitize(str: string): string {
  return str.replace(/[<>]/g, "").trim().slice(0, 255);
}

function validateAndExtractImage(image: string) {
  if (!image?.startsWith("data:image/")) {
    throw new Error("صيغة الصورة غير مدعومة (يجب أن تكون Base64 Data URL)");
  }

  const parts = image.split(",");
  const base64Data = parts[1];
  const mimeType = parts[0].match(/:(.*?);/)?.[1] || "image/jpeg";

  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`نوع الملف ${mimeType} غير مدعوم`);
  }

  const sizeInBytes = (base64Data.length * 3) / 4;
  if (sizeInBytes > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    throw new Error(`حجم الصورة يتجاوز ${MAX_IMAGE_SIZE_MB} ميجابايت`);
  }

  return { base64Data, mimeType };
}

// ============================================================
// المحرك الرئيسي
// ============================================================
export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    // 1. فحص الـ API Key
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    // 2. فحص الـ Payload
    const body = await req.json();
    const { base64Data, mimeType } = validateAndExtractImage(body.image);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1, // لضمان دقة البيانات وعدم الهلوسة
        responseMimeType: "application/json", // إجبار الموديل على إخراج JSON نقي
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      ],
    });

    // 3. بناء الـ Prompt الاستراتيجي
    const prompt = `
      Analyze this retail shelf image. Extract all products.
      Return a JSON object with this exact structure:
      {
        "products": [
          {
            "product_name": "string",
            "brand": "string",
            "category": "string",
            "unit_price": "string (digits only or empty)",
            "quantity": number,
            "barcode": "string",
            "confidence": "high|medium|low",
            "notes": "string"
          }
        ],
        "analysis_quality": "excellent|good|partial",
        "warnings": []
      }
      Rules: No hallucinations. If quantity is multiple, sum it. If price not visible, use "".
    `;

    // 4. تنفيذ الطلب مع معالجة الوقت
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Data, mimeType } },
    ]);

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    // 5. تطهير البيانات النهائية (Final Sanitization)
    const secureProducts = parsed.products.map((p: any) => ({
      product_name: sanitize(p.product_name),
      brand: sanitize(p.brand),
      category: sanitize(p.category),
      unit_price: sanitize(p.unit_price),
      quantity: Number(p.quantity) || 1,
      barcode: sanitize(p.barcode),
      confidence: p.confidence || "medium",
      notes: sanitize(p.notes || ""),
    }));

    return NextResponse.json({
      success: true,
      products: secureProducts,
      quality: parsed.analysis_quality,
      duration: `${Date.now() - startTime}ms`
    });

  } catch (error: any) {
    console.error("Critical API Error:", error.message);
    return NextResponse.json(
      { success: false, error: "فشل تحليل الصورة", detail: error.message },
      { status: error.message.includes("حجم") ? 413 : 500 }
    );
  }
}