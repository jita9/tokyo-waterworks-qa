import { GoogleGenerativeAI } from '@google/generative-ai';

// Interface representing our specifications data structure
export interface PageData {
  page_number: number;
  text: string;
}

export interface DocumentData {
  id: string;
  title: string;
  url: string;
  pages: PageData[];
  total_pages: number;
  file_size: string;
}

// Generate the context block for selected documents
export function buildContextPrompt(selectedDocs: DocumentData[]): string {
  if (selectedDocs.length === 0) {
    return "現在、資料は何も選択されていません。質問に答えるための情報がありません。";
  }

  let context = "以下は東京都水道局の「指定給水装置工事事業者工事施行要領」の公式資料です。このコンテキスト情報のみに基づいてユーザーの質問に回答してください。\n\n";
  context += "--- START OF DOCUMENTS ---\n\n";

  for (const doc of selectedDocs) {
    context += `【ドキュメント名】: ${doc.title}\n`;
    context += `【URL】: ${doc.url}\n`;
    context += `【内容】:\n`;
    
    for (const page of doc.pages) {
      context += `[ページ ${page.page_number}]:\n${page.text}\n\n`;
    }
    
    context += "----------------------------------------\n\n";
  }

  context += "--- END OF DOCUMENTS ---\n\n";
  context += "回答のルール:\n";
  context += "1. 回答は日本語で、わかりやすく、構造的に記述してください（箇条書き、太字、ヘッダー等を使用）。\n";
  context += "2. 回答内の事実には、必ず引用元ドキュメント名とページ番号を `[ドキュメント名 (p. ページ番号)]` の形式で含めてください。例: `...となります [第１章 水道 (p. 3)]`。複数のページから引用する場合は `[第１章 水道 (p. 3, p. 5)]` のようにしてください。\n";
  context += "3. 提供された資料（コンテキスト）に記載されていない情報については、「提供された資料には記載されていません」と明記し、憶測で答えないでください。\n";
  context += "4. 施工要領に直接言及されていない一般的な知識や他の自治体のルールは含めないでください。";

  return context;
}

// Service to call Gemini API
export class GeminiService {
  private ai: GoogleGenerativeAI | null = null;
  private apiKey: string = "";

  constructor(apiKey: string) {
    this.setApiKey(apiKey);
  }

  public setApiKey(apiKey: string) {
    this.apiKey = apiKey.trim();
    if (this.apiKey) {
      this.ai = new GoogleGenerativeAI(this.apiKey);
    } else {
      this.ai = null;
    }
  }

  public hasKey(): boolean {
    return !!this.ai;
  }

  // Ask a question based on selected documents
  public async askQuestion(
    question: string,
    selectedDocs: DocumentData[],
    history: { role: 'user' | 'model'; parts: { text: string }[] }[] = []
  ): Promise<string> {
    if (!this.ai) {
      throw new Error("Gemini APIキーが設定されていません。右上の設定から入力してください。");
    }

    try {
      const model = this.ai.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      const contextPrompt = buildContextPrompt(selectedDocs);
      
      // Structure the full prompt
      const systemInstruction = contextPrompt;
      
      // Call generateContent with systemInstructions
      const chat = model.startChat({
        history: history.map(h => ({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.parts[0].text }]
        })),
        systemInstruction: systemInstruction,
      });

      const response = await chat.sendMessage(question);
      const text = response.response.text();
      
      if (!text) {
        throw new Error("APIから空の回答が返されました。");
      }
      
      return text;
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      throw new Error(error.message || "Gemini APIの呼び出し中にエラーが発生しました。");
    }
  }

  // Generate a summary and suggested questions for a single document
  public async generateSummary(doc: DocumentData): Promise<{ summary: string; questions: string[] }> {
    if (!this.ai) {
      throw new Error("Gemini APIキーが設定されていません。");
    }

    try {
      const model = this.ai.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      let docContent = `【ドキュメント名】: ${doc.title}\n【内容】:\n`;
      for (const page of doc.pages) {
        docContent += `[ページ ${page.page_number}]:\n${page.text}\n\n`;
      }

      const prompt = `${docContent}

上記のドキュメントの内容について、以下の2点を作成してください：
1. 資料全体の簡潔な要約（箇条書きで3〜4項目、日本語）
2. この資料の内容に基づいて、ユーザーが質問しそうな具体的な質問例（3個、日本語）

出力は必ず以下のJSON形式にしてください。他の文章や解説は一切含めないでください。JSONコードブロックマーク (\`\`\`json) も含めず、純粋なJSON文字列として返してください。

{
  "summary": "・要約項目1\\n・要約項目2\\n・要約項目3",
  "questions": [
    "質問例1",
    "質問例2",
    "質問例3"
  ]
}`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      
      if (!text) {
        throw new Error("要約の作成に失敗しました。");
      }
      
      // Parse JSON from response
      const cleanJsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const data = JSON.parse(cleanJsonStr);
      
      return {
        summary: data.summary || "要約を生成できませんでした。",
        questions: data.questions || []
      };
    } catch (error: any) {
      console.error("Summary generation error:", error);
      // Fallback
      return {
        summary: "要約の自動生成中にエラーが発生しました。資料の内容を直接ご参照ください。",
        questions: [
          `${doc.title}の主な内容は何ですか？`,
          `${doc.title}における重要な変更点は？`,
          `${doc.title}の適用範囲を教えてください。`
        ]
      };
    }
  }
}
