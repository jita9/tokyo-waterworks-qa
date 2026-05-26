import { useState, useEffect, useRef } from 'react';
import { 
  BookOpen, 
  Send, 
  Plus, 
  Trash2, 
  Download, 
  Sparkles, 
  Settings, 
  Key, 
  Check, 
  AlertTriangle,
  Lightbulb,
  Pin,
  RefreshCw,
  Sun,
  Moon,
  ChevronDown,
  ChevronUp,
  FileText
} from 'lucide-react';
import Markdown from 'markdown-to-jsx';
import './App.css';
import { GeminiService, retrieveRelevantPages } from './services/gemini';
import type { DocumentData } from './services/gemini';
import rawSpecs from './data/specifications.json';
import rawFaqs from './data/faq.json';


// Cast imported JSON to our type
const specificationsData = [
  ...(rawSpecs as DocumentData[]),
  ...(rawFaqs as DocumentData[])
];

// Helper to get actual document page label (e.g. 3-15 instead of p.17)
export function getPageLabel(docId: string, pageNumber: number, pageText: string): string {
  let prefix = "";
  if (docId === 'chapter-1') prefix = "1";
  else if (docId === 'chapter-2') prefix = "2";
  else if (docId === 'chapter-3') prefix = "3";
  else if (docId === 'standards') prefix = "4";
  else if (docId === 'laws') prefix = "6";

  if (prefix) {
    const startText = pageText.substring(0, 300);
    const regex = new RegExp(`\\b(${prefix}-\\d+)\\b`);
    const match = startText.match(regex);
    if (match) return match[1];
    
    const endText = pageText.substring(Math.max(0, pageText.length - 300));
    const endMatch = endText.match(regex);
    if (endMatch) return endMatch[1];
  }
  
  return `p. ${pageNumber}`;
}

// Convert model citations like [第３章 手続 (p. 15)] to markdown links with accurate labels
export function linkifyCitations(text: string, documents: DocumentData[]): string {
  const regex = /\[([^\]\(]+)\s*\(p\.\s*(\d+(?:\s*,\s*p\.\s*\d+)*)\)\]/g;
  
  return text.replace(regex, (fullMatch, docTitle, pagesStr) => {
    const doc = documents.find(d => d.title.trim() === docTitle.trim());
    if (!doc) return fullMatch;
    
    const pageNums = pagesStr
      .split(',')
      .map((s: string) => parseInt(s.replace(/[^\d]/g, ''), 10))
      .filter((n: number) => !isNaN(n));
      
    const links = pageNums.map((pNum: number) => {
      const page = doc.pages.find(p => p.page_number === pNum);
      const label = getPageLabel(doc.id, pNum, page ? page.text : '');
      return `[${label}](${doc.url}#page=${pNum})`;
    });
    
    return `[${doc.title} (${links.join(', ')})]`;
  });
}

interface Message {
  role: 'user' | 'model';
  parts: { text: string }[];
  timestamp: Date;
  id: string;
  references?: { docTitle: string; pages: number[] }[];
}


interface Note {
  id: string;
  title: string;
  content: string;
  timestamp: Date;
}

// Error sanitization utility to prevent huge dumps in the UI
const sanitizeError = (error: any): string => {
  if (!error) return "原因不明のエラーが発生しました。";
  
  let msg = "";
  if (typeof error === 'string') {
    msg = error;
  } else if (error instanceof Error) {
    msg = error.message;
  } else if (typeof error === 'object') {
    msg = error.message || error.statusText || JSON.stringify(error);
  } else {
    msg = String(error);
  }

  const msgLower = msg.toLowerCase();
  if (
    msgLower.includes("api_key_invalid") || 
    msgLower.includes("api key not valid") || 
    msgLower.includes("invalid api key") ||
    msgLower.includes("api key expired")
  ) {
    return "APIキーが無効です。有効なGemini APIキーを設定してください。";
  }
  if (
    msgLower.includes("quota") || 
    msgLower.includes("quota_exceeded") || 
    msgLower.includes("rate limit") || 
    msgLower.includes("429")
  ) {
    return "APIの利用制限（クォータ）を超過しました。左側パネルで選択する資料のチェックをいくつか外し、送信サイズを減らして1分ほど待ってから再度お試しください。";
  }
  if (
    msgLower.includes("503") || 
    msgLower.includes("high demand") || 
    msgLower.includes("service unavailable") ||
    msgLower.includes("overloaded")
  ) {
    return "APIサーバーが現在混雑しています（503エラー）。右上の設定アイコン（歯車）から「使用するモデル」を別のもの（例: gemini-3.5-flash や gemini-2.5-pro）に変更してお試しください。";
  }
  
  // Safeguard: Truncate very long error payloads to prevent UI layout explosions
  if (msg.length > 250) {
    return msg.substring(0, 250) + "... (詳細はブラウザのコンソールログを確認してください)";
  }
  return msg;
};

export default function App() {
  // App state
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('gemini_api_key') || '';
  });
  
  // Demo Mode state
  const [isDemoMode, setIsDemoMode] = useState<boolean>(() => {
    return localStorage.getItem('is_demo_mode') === 'true';
  });

  const [showKeyModal, setShowKeyModal] = useState<boolean>(!apiKey && !isDemoMode);
  const [tempKey, setTempKey] = useState<string>(apiKey);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('app_theme') as 'dark' | 'light') || 'dark';
  });
  
  // Selected documents state (defaults to all selected)
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(() => {
    return new Set(specificationsData.map(doc => doc.id));
  });

  // Cached summaries and suggested questions
  const [summaries, setSummaries] = useState<Record<string, { summary: string; questions: string[] }>>({});
  const [loadingSummaryDocId, setLoadingSummaryDocId] = useState<string | null>(null);
  const [expandedDocSummary, setExpandedDocSummary] = useState<string | null>(null);

  // Chat state
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoFilter, setAutoFilter] = useState<boolean>(() => {
    return localStorage.getItem('auto_filter_context') !== 'false';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem('gemini_model_name') || 'gemini-2.5-flash';
  });
  const [tempModel, setTempModel] = useState<string>(selectedModel);

  
  // Notes state
  const [notes, setNotes] = useState<Note[]>(() => {
    const saved = localStorage.getItem('saved_notes');
    return saved ? JSON.parse(saved) : [];
  });
  const [noteTitle, setNoteTitle] = useState<string>('');
  const [noteContent, setNoteContent] = useState<string>('');
  const [isGeneratingStudyGuide, setIsGeneratingStudyGuide] = useState<boolean>(false);

  // Gemini service reference
  const geminiRef = useRef<GeminiService>(new GeminiService(apiKey, selectedModel));

  useEffect(() => {
    if (showKeyModal) {
      setTempKey(apiKey);
      setTempModel(selectedModel);
    }
  }, [showKeyModal, apiKey, selectedModel]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Suggested questions dashboard
  const defaultQuestions = [
    { text: "給水装置工事の設計からしゅん工検査までの一般的な流れは？", tag: "手続" },
    { text: "指定事業者の指定の要件（欠格要件）と、変更届が必要なケースは？", tag: "事業者" },
    { text: "給水管を道路や私道に埋設する際の深さ（土被り）の基準は？", tag: "施工基準" },
    { text: "受水槽以下の給水装置（簡易専用水道等）の管理義務と検査について", tag: "水道法" },
    { text: "引っ越しの手続きは何日前までにすればいい？", tag: "引越しFAQ" },
    { text: "漏水しているか確かめる方法は？", tag: "漏水FAQ" },
    { text: "蛇口から赤い水や白い濁り水が出たら？", tag: "水質FAQ" }
  ];

  // Save notes to localStorage
  useEffect(() => {
    localStorage.setItem('saved_notes', JSON.stringify(notes));
  }, [notes]);

  // Apply theme class
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light-mode');
    } else {
      root.classList.remove('light-mode');
    }
    localStorage.setItem('app_theme', theme);
  }, [theme]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isGenerating]);

  // Handle settings submission
  const handleSaveKey = () => {
    const cleanKey = tempKey.trim();
    setApiKey(cleanKey);
    localStorage.setItem('gemini_api_key', cleanKey);
    
    setSelectedModel(tempModel);
    localStorage.setItem('gemini_model_name', tempModel);

    geminiRef.current.setApiKey(cleanKey);
    geminiRef.current.setModelName(tempModel);

    setIsDemoMode(false);
    localStorage.setItem('is_demo_mode', 'false');
    setShowKeyModal(false);
  };

  // Toggle document selection
  const toggleDocSelection = (id: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllDocs = () => {
    setSelectedDocIds(new Set(specificationsData.map(doc => doc.id)));
  };

  const clearAllDocs = () => {
    setSelectedDocIds(new Set());
  };

  // Trigger single document summary generation
  const handleSummarizeDoc = async (doc: DocumentData) => {
    if (isDemoMode) {
      // Return predefined summaries for demo mode
      setLoadingSummaryDocId(doc.id);
      setTimeout(() => {
        const dummySummaries: Record<string, { summary: string; questions: string[] }> = {
          cover: {
            summary: "・本要領の改正の趣旨と沿革についての説明。\n・給水装置工事主任技術者制度の創設と近代水道の歴史。\n・水道事業者としての東京都水道局の使命と概要。",
            questions: ["東京の近代水道はいつ始まりましたか？", "この要領が改正された目的は何ですか？", "はじめにの要点を知りたい"]
          },
          toc: {
            summary: "・全体の章立てと項目の一覧。\n・第1章から第3章までの構成と、添付基準・様式等のインデックス。",
            questions: ["目次の構成を教えてください", "設計・施工基準はどこにありますか？", "提出書類の様式はどこ？"]
          },
          "chapter-1": {
            summary: "・水道法上の「水道の定義」および用語の解説。\n・給水装置の構造・材質基準の基本的な説明。\n・給水区域と水質基準の遵守義務に関する規定。",
            questions: ["給水装置の定義とは？", "水道法における水道の種類について", "水質基準はどのように定められていますか？"]
          },
          "chapter-2": {
            summary: "・指定給水装置工事事業者の義務と責任。\n・給水装置工事主任技術者の役割と選任要件。\n・指定事業者が順守すべき基本ルールと現場管理体制。",
            questions: ["指定事業者の義務とは？", "主任技術者の具体的な職務内容は？", "指定取り消しになるケースは？"]
          },
          "chapter-3": {
            summary: "・給水装置工事の申請、審査、検査に係る各種手続。\n・新規指定申請、変更届、廃止届等の事務手続の流れ。\n・工事着工前および完了時の提出書類の一覧と期限。",
            questions: ["工事申請に必要な書類は？", "指定の有効期間は何年ですか？", "しゅん工検査 of 申請手順は？"]
          },
          standards: {
            summary: "・給水管の材質選定、口径決定、配管ルート選定の設計基準。\n* 土被り（埋設深さ）の公道・私道・宅地内ごとの基準数値。\n・水撃防止、凍結防止、逆流防止等の防護対策の実務仕様。",
            questions: ["埋設深さの基準数値は？", "水圧試験の圧力値と保持時間は？", "逆流防止の対策基準は？"]
          },
          "faq-relocation": {
            summary: "・引越し時の水道開始・中止手続きの流れ。\n・マイネットでのインターネット申し込みや電話での受付期限。",
            questions: ["引っ越しの手続きは何日前までにすればいい？", "インターネット手続きは24時間可能ですか？"]
          },
          "faq-billing": {
            summary: "・水道料金の支払い方法（口座振替、クレジットカード、請求書、モバイル決済）。\n・不可抗力による漏水時の料金減免制度の適用要件。",
            questions: ["水道料金の支払い方法には何がありますか？", "水漏れしていたら水道料金は安くなりますか？"]
          },
          "faq-leakage": {
            summary: "・宅内での漏水（水漏れ）の有無をメーターのパイロットで確認する手順。\n・メーター前後の修理費用負担と責任区分（道路側は水道局、宅内側は自己負担）。",
            questions: ["水漏れしているか確かめる方法は？", "水道メーターより宅内側の修理費用は自己負担ですか？"]
          },
          "faq-water": {
            summary: "・蛇口からの赤水（鉄サビ）や白濁水（気泡）の原因と対応方法。\n・マンションやビルの受水槽（貯水槽水道）の清掃・検査管理義務。",
            questions: ["蛇口から白い水が出た時の対応は？", "マンションの受水槽は誰が清掃する義務がありますか？"]
          },
          "faq-construction": {
            summary: "・給水装置工事の指定事業者への依頼と契約について。\n・給水装置図面の閲覧および謄本（写し）交付の窓口手続き。",
            questions: ["給水装置工事はどこに頼めばいい？", "自宅の水道配管図（図面）を見たい"]
          }
        };

        const res = dummySummaries[doc.id] || {
          summary: `・${doc.title}の概要と重要事項の整理。\n・関係する規定や手続きについての説明。`,
          questions: [`${doc.title}の重要ポイントは？`, `${doc.title}に関連する手続きは？`, `${doc.title}の適用範囲は？`]
        };

        setSummaries(prev => ({ ...prev, [doc.id]: res }));
        setExpandedDocSummary(doc.id);
        setLoadingSummaryDocId(null);
      }, 600);
      return;
    }

    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }
    setLoadingSummaryDocId(doc.id);
    setErrorMsg(null);
    try {
      const res = await geminiRef.current.generateSummary(doc);
      setSummaries(prev => ({
        ...prev,
        [doc.id]: res
      }));
      setExpandedDocSummary(doc.id);
    } catch (e: any) {
      setErrorMsg(sanitizeError(e));
    } finally {
      setLoadingSummaryDocId(null);
    }
  };

  // Ask question handler
  const handleSendQuestion = async (textToSend: string) => {
    const query = textToSend.trim();
    if (!query) return;

    if (!apiKey && !isDemoMode) {
      setShowKeyModal(true);
      return;
    }

    const selectedDocs = specificationsData.filter(doc => selectedDocIds.has(doc.id));
    if (selectedDocs.length === 0) {
      setErrorMsg("資料が選択されていません。左側のパネルで少なくとも1つの資料を選択してください。");
      return;
    }

    setErrorMsg(null);
    setIsGenerating(true);
    setUserInput('');

    // Add user message to history
    const userMsgId = crypto.randomUUID();
    const newUserMsg: Message = {
      id: userMsgId,
      role: 'user',
      parts: [{ text: query }],
      timestamp: new Date()
    };
    
    setChatHistory(prev => [...prev, newUserMsg]);

    // Handle Demo Mode response
    if (isDemoMode) {
      setTimeout(() => {
        let reply = "";
        const qClean = query.toLowerCase();
        
        if (qClean.includes("設計から") || qClean.includes("しゅん工") || qClean.includes("流れ")) {
          reply = `東京都水道局における給水装置工事の一般的なフローは以下の通りです：

1. **設計・申込**: 指定給水装置工事事業者が設計図書を作成し、水道局事業所に承認申請を行います \`[第３章 手続 (p. 2)]\`。
2. **審査・承認**: 水道局が設計内容を審査し、適合していれば承認し、手数料等の納付を求めます。
3. **施工**: 承認後、配水管からの分岐工事および宅内配管の工事を行います \`[第２章 指定給水装置工事事業者 (p. 5)]\`。
4. **しゅん工検査**: 工事完了後、水道局によるしゅん工検査を受けます。水圧試験や材料確認などが行われます \`[第３章 手続 (p. 15)]\`。`;
        } else if (qClean.includes("要件") || qClean.includes("欠格") || qClean.includes("変更届")) {
          reply = `指定給水装置工事事業者の指定要件と届出手続きは以下の通りです：

* **指定要件**: 
  1. 事業所ごとに給水装置工事主任技術者を選任していること \`[第２章 指定給水装置工事事業者 (p. 2)]\`。
  2. 厚生労働省令で定める機械器具（水圧テストポンプ、管の切断機、加工用の工具等）を有していること。
  3. 破産者などの欠格要件に該当しないこと。
* **変更届が必要なケース**:
  以下の場合、変更のあった日から30日以内に届出が必要です \`[第３章 手続 (p. 8)]\`：
  - 氏名または名称、住所、代表者名の変更
  - 役員の変更
  - 給水装置工事主任技術者の選任・解任または氏名の変更`;
        } else if (qClean.includes("埋設") || qClean.includes("土被り") || qClean.includes("深さ")) {
          reply = `給水管の埋設深さ（土被り）の基準は、埋設場所によって異なります：

* **公道（都道・区市町村道など）**:
  - 原則として、配水管と同様に**1.2m以上**の土被りを確保する必要があります。ただし、現場の状況により困難な場合は**0.6m〜0.9m**まで緩和される場合があります \`[給水装置設計・施工基準 (p. 24)]\`。
* **私道内**:
  - 私道内における給水管の埋設深さは、原則として**0.6m以上**（車両が進入しない箇所では**0.45m以上**）と定められています \`[給水装置設計・施工基準 (p. 26)]\`。
* **宅地内**:
  - 宅地内では、原則として**0.3m以上**の深さに埋設します（車両の載るおそれのある部分はさらに保護措置を行う必要があります）。`;
        } else if (qClean.includes("受水槽") || qClean.includes("簡易専用水道") || qClean.includes("検査")) {
          reply = `受水槽以下の給水設備に関する管理基準は以下の通りです：

* **簡易専用水道（受水槽の有効容量が10立方メートルを超えるもの）**:
  - 水道法に基づき、設置者は年1回以上、厚生労働大臣の登録を受けた検査機関による定期検査を受ける義務があります \`[関係法令 (p. 4)]\`。
  - 水槽の清掃を年1回以上定期的に行う必要があります。
* **小規模水道（受水槽の有効容量が10立方メートル以下のもの）**:
  - 東京都水道局の給水条例等に基づき、簡易専用水道に準じた適正な管理（清掃、水質点検など）を行うよう努める必要があります。`;
        } else if (qClean.includes("引越し") || qClean.includes("引っ越し") || qClean.includes("開始") || qClean.includes("中止")) {
          reply = `東京都水道局におけるお引越し時の水道手続きは以下の通りです：

1. **お申込み方法**: インターネット（「東京水道マイネット」またはアプリ）、またはお客さまセンターへのお電話にてお申込みいただけます。
2. **お申込み期限**: 原則としてお引越し予定日の**3〜4日前**までに手続きを行ってください。当日や前日などの直前の場合は、お電話で直接ご連絡いただく必要があります。
3. **必要な情報**: 検針票や請求書に記載されている**「お客さま番号」**があると、よりスムーズにお手続きいただけます \`[FAQ: お引越しの手続き (p. 1)]\`。`;
        } else if (qClean.includes("料金") || qClean.includes("支払い") || qClean.includes("減免")) {
          reply = `水道料金のお支払い方法および減免制度は以下の通りです：

* **お支払い方法**: 以下の4種類から選択可能です \`[FAQ: 水道料金・お支払い (p. 1)]\`。
  1. 口座振替（自動引き落とし）
  2. クレジットカード払い（事前登録）
  3. 請求書（納入通知書）によるお支払い（コンビニ、金融機関、郵便局、または各種スマホ決済アプリ）
  4. モバイル決済（キャッシュレスその場決済）
* **漏水時の料金減免**: 壁の中や地中など、目に見えない場所（発見困難な場所）での漏水について、指定給水装置工事事業者により修理が行われた場合に限り、申請によって料金の一部が減免される制度があります \`[FAQ: 水道料金・お支払い (p. 2)]\`。`;
        } else if (qClean.includes("漏水") || qClean.includes("水漏れ") || qClean.includes("メーター") || qClean.includes("パイロット")) {
          reply = `水漏れの確認方法と修理の責任区分は以下の通りです：

* **水漏れ（漏水）の確認手順** \`[FAQ: 漏水・修繕トラブル (p. 1)]\`:
  1. 家の中の全ての蛇口を閉めます。
  2. 水道メーターボックス内のメーター文字盤中央にある「パイロット」（銀色や金色の丸い円盤）が回転しているか確認します。
  3. 少しでも回転していれば、メーターから蛇口までのどこかで漏水している可能性があります。
* **修理の費用と責任区分** \`[FAQ: 漏水・修繕トラブル (p. 2)]\`:
  - **水道メーターから道路側**: 東京都水道局が管理・修理します（原則自己負担なし）。
  - **水道メーターから宅内側**: お客様の管理範囲です。修理費用はお客様負担となりますので、東京都指定給水装置工事事業者へ直接修理を依頼してください。`;
        } else if (qClean.includes("赤水") || qClean.includes("白い水") || qClean.includes("濁水") || qClean.includes("赤い水")) {
          reply = `蛇口から出る濁り水の原因と対応は以下の通りです：

1. **赤い水（鉄サビ）** \`[FAQ: 水質・受水槽 (p. 1)]\`:
   - 近隣での水道工事や消火活動などで水道管内の流れが急に変わり、鉄サビが流れ出たことが主な原因です。少しの間流したままにして、透明になってから使用してください。少量誤って飲んでしまっても健康への影響はありません。
2. **白い濁り水（気泡）** \`[FAQ: 水質・受水槽 (p. 1)]\`:
   - 水の中に細かな気泡（空気）が混入したためで、コップにくんでしばらく置くと下から透明になります。安全性や健康への影響は全くありません。`;
        } else if (qClean.includes("図面") || qClean.includes("配管") || qClean.includes("閲覧") || qClean.includes("謄本") || qClean.includes("依頼")) {
          reply = `給水装置工事の依頼先および配管図面の確認方法は以下の通りです：

* **工事の依頼先** \`[FAQ: 給水装置工事・手続き (p. 1)]\`:
  - 給水装置工事は、東京都から指定を受けた「東京都指定給水装置工事事業者」でなければ施工できません。無資格者による施工は水道法で禁止されています。工事契約は民間同士の契約となるため、水道局は関与しません。
* **配管図（図面）の閲覧・謄本交付** \`[FAQ: 給水装置工事・手続き (p. 2)]\`:
  - 土地所有者などの権利関係者（またはその委任を受けた代理人）が、管轄の給水管工事事務所（23区）またはサービスステーション（多摩地区）の窓口へ来所して申請する必要があります。個人情報保護のため事前予約や身分証明書、委任状等の持参が必要です。`;
        } else {
          reply = `デモモードでは、よくある質問例（手続、事業者、施工基準、水道法）に対してのみ回答をご用意しております。
          
全ての質問に対して施工要領から自動回答を得るには、右上の「APIキー設定」から有効なGemini APIキーを入力し、デモモードを解除してください。`;
        }

        const botMsgId = crypto.randomUUID();
        const newBotMsg: Message = {
          id: botMsgId,
          role: 'model',
          parts: [{ text: reply }],
          timestamp: new Date()
        };
        setChatHistory(prev => [...prev, newBotMsg]);
        setIsGenerating(false);
      }, 1000);
      return;
    }

    // Determine which documents/pages to actually send to the API
    let docsToSend = selectedDocs;
    let referencesForMessage: { docTitle: string; pages: number[] }[] = [];

    if (autoFilter) {
      docsToSend = retrieveRelevantPages(query, selectedDocs, 20);
      referencesForMessage = docsToSend.map(doc => ({
        docTitle: doc.title,
        pages: doc.pages.map(p => p.page_number)
      })).filter(ref => ref.pages.length > 0);
    }

    try {
      const apiHistory = chatHistory.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.parts[0].text }]
      }));

      const reply = await geminiRef.current.askQuestion(query, docsToSend, apiHistory);
      
      const botMsgId = crypto.randomUUID();
      const newBotMsg: Message = {
        id: botMsgId,
        role: 'model',
        parts: [{ text: reply }],
        timestamp: new Date(),
        references: referencesForMessage.length > 0 ? referencesForMessage : undefined
      };
      setChatHistory(prev => [...prev, newBotMsg]);
    } catch (e: any) {
      setErrorMsg(sanitizeError(e));
      // Rollback: Remove the user message that failed to get a response
      setChatHistory(prev => prev.filter(msg => msg.id !== userMsgId));
    } finally {
      setIsGenerating(false);
    }
  };


  // Add custom note
  const handleAddNote = () => {
    if (!noteTitle.trim() || !noteContent.trim()) return;
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: noteTitle.trim(),
      content: noteContent.trim(),
      timestamp: new Date()
    };
    setNotes(prev => [newNote, ...prev]);
    setNoteTitle('');
    setNoteContent('');
  };

  // Pin message as note
  const handlePinMessage = (msg: Message) => {
    const cleanText = msg.parts[0].text;
    const preview = cleanText.substring(0, 30) + (cleanText.length > 30 ? '...' : '');
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: `AI回答のピン留め: ${preview}`,
      content: cleanText,
      timestamp: new Date()
    };
    setNotes(prev => [newNote, ...prev]);
  };

  // Delete note
  const handleDeleteNote = (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
  };

  // Export notes as Markdown
  const handleExportNotes = () => {
    if (notes.length === 0) return;
    let md = "# 東京都水道局 施工要領学習ノート\n\n";
    notes.forEach(note => {
      md += `## ${note.title}\n`;
      md += `*作成日時: ${new Date(note.timestamp).toLocaleString()}*\n\n`;
      md += `${note.content}\n\n`;
      md += "---\n\n";
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `waterworks_notes_${new Date().toISOString().slice(0,10)}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Generate Study Guide from Notes using Gemini
  const handleGenerateStudyGuide = async () => {
    if (notes.length === 0) {
      setErrorMsg("学習ガイドを生成するためのノートが登録されていません。");
      return;
    }

    if (isDemoMode) {
      setIsGeneratingStudyGuide(true);
      setTimeout(() => {
        const dummyGuide = `# 【デモ用】施工要領重要ポイント学習ガイド

ユーザー様のメモを元に整理した、施工要領の重要ポイント一覧です。

## 1. 給水装置工事の流れ
- 指定事業者が設計書を作成し、水道局に事前申請を行います。
- 工事完了後は、水道局の完了検査（水圧テスト等）が必須です。

## 2. 指定事業者の義務
- 各事業所に必ず「給水装置工事主任技術者」を選任・配置すること。
- 機械器具の適切な保守管理と、変更があった際の届出義務（30日以内）。

## 3. 埋設基準（土被り）
- 公道: 原則 **1.2m以上**
- 私道: 原則 **0.6m以上**
- 宅地内: 原則 **0.3m以上**`;

        const studyGuideNote: Note = {
          id: crypto.randomUUID(),
          title: "✨ 生成された学習ガイド（デモ）",
          content: dummyGuide,
          timestamp: new Date()
        };
        setNotes(prev => [studyGuideNote, ...prev]);
        setIsGeneratingStudyGuide(false);
      }, 1000);
      return;
    }

    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }

    setIsGeneratingStudyGuide(true);
    setErrorMsg(null);

    try {
      const model = geminiRef.current['ai']?.getGenerativeModel({ model: "gemini-2.5-flash" });
      if (!model) throw new Error("Gemini AI Client is not initialized.");

      let notesContent = "";
      notes.forEach((n, idx) => {
        notesContent += `[ノート ${idx + 1}] タイトル: ${n.title}\n内容:\n${n.content}\n\n`;
      });

      const prompt = `以下のユーザーが保存したノートの情報を元に、重要ポイントを整理した「施工要領学習ガイド」を作成してください。
内容を整理・体系化し、試験対策や現場でのチェックリストとして役立つようにまとめてください。

【ノート内容】
${notesContent}

回答はMarkdown形式で、日本語で詳細かつ見やすく出力してください。`;

      const result = await model.generateContent(prompt);
      const reply = result.response.text();
      
      if (!reply) throw new Error("APIから空の回答が返されました。");

      const studyGuideNote: Note = {
        id: crypto.randomUUID(),
        title: "✨ 生成された学習ガイド/チェックリスト",
        content: reply,
        timestamp: new Date()
      };
      setNotes(prev => [studyGuideNote, ...prev]);
    } catch (e: any) {
      setErrorMsg(sanitizeError(e));
    } finally {
      setIsGeneratingStudyGuide(false);
    }
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header glass-panel">
        <div className="header-left">
          <div className="logo">💧</div>
          <div className="title-group">
            <h1>東京水道局 施工要領 AIアシスタント</h1>
            <p className="subtitle">指定給水装置工事事業者工事施行要領 (令和8年4月版) 対応</p>
          </div>
        </div>
        <div className="header-actions">
          {isDemoMode && (
            <div className="demo-badge">
              <span>デモモード動作中</span>
            </div>
          )}
          <button 
            className={`theme-toggle ${theme}`} 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="テーマ切り替え"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button 
            className={`api-key-btn ${apiKey ? 'configured' : isDemoMode ? 'configured' : 'missing'}`}
            onClick={() => setShowKeyModal(true)}
            title="APIキー設定"
          >
            <Settings size={18} />
            <span>{apiKey ? 'APIキー設定済' : isDemoMode ? 'デモモード (キー未設定)' : 'APIキー未設定'}</span>
          </button>
        </div>
      </header>

      {/* Main Board Grid */}
      <main className="app-main">
        {/* Left Side: Sources Selection Panel */}
        <section className="panel-sources glass-panel">
          <div className="panel-header">
            <BookOpen size={18} className="icon-blue" />
            <h2>ドキュメントソース ({specificationsData.length})</h2>
          </div>
          
          <div className="source-controls">
            <button className="text-btn" onClick={selectAllDocs}>すべて選択</button>
            <span className="divider">|</span>
            <button className="text-btn" onClick={clearAllDocs}>すべて解除</button>
          </div>

          <div className="sources-list scrollable">
            {specificationsData.map(doc => {
              const isSelected = selectedDocIds.has(doc.id);
              const summaryData = summaries[doc.id];
              const isExpanded = expandedDocSummary === doc.id;

              return (
                <div key={doc.id} className={`source-card ${isSelected ? 'selected' : ''}`}>
                  <div className="source-card-header">
                    <label className="checkbox-container">
                      <input 
                        type="checkbox" 
                        checked={isSelected}
                        onChange={() => toggleDocSelection(doc.id)} 
                      />
                      <span className="checkmark"></span>
                      <span className="doc-title">{doc.title}</span>
                    </label>
                    
                    <button 
                      className={`summary-btn ${summaryData ? 'has-summary' : ''}`}
                      onClick={() => handleSummarizeDoc(doc)}
                      disabled={loadingSummaryDocId === doc.id}
                      title={summaryData ? "要約を表示" : "AIで要約を生成"}
                    >
                      {loadingSummaryDocId === doc.id ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span>要約</span>
                    </button>
                  </div>

                  <div className="source-meta">
                    <span>ページ数: {doc.total_pages}p</span>
                    <span>サイズ: {doc.file_size}</span>
                  </div>

                  {summaryData && (
                    <div className="doc-summary-collapsible">
                      <button 
                        className="summary-collapse-header"
                        onClick={() => setExpandedDocSummary(isExpanded ? null : doc.id)}
                      >
                        <span>{isExpanded ? '要約を隠す' : '要約を表示'}</span>
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      
                      {isExpanded && (
                        <div className="summary-content animate-fade-in">
                          <div className="summary-text">
                            <Markdown>{summaryData.summary}</Markdown>
                          </div>
                          {summaryData.questions && summaryData.questions.length > 0 && (
                            <div className="suggested-subquestions">
                              <p className="sub-title"><Lightbulb size={12} /> おすすめの質問:</p>
                              <ul>
                                {summaryData.questions.map((q, idx) => (
                                  <li key={idx} onClick={() => handleSendQuestion(q)} className="clickable-q">
                                    {q}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          
          <div className="sources-footer animate-fade-in">
            <div className="filter-toggle-container">
              <label className="checkbox-container">
                <input 
                  type="checkbox" 
                  checked={autoFilter}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setAutoFilter(val);
                    localStorage.setItem('auto_filter_context', String(val));
                  }} 
                />
                <span className="checkmark"></span>
                <span className="toggle-label font-semibold">関連ページを自動抽出 (推奨)</span>
              </label>
              <p className="toggle-hint">質問ごとに関連性の高い上位20ページに自動で絞り込み、API制限エラー（429）を防止します。</p>
            </div>

            {(() => {
              const activePages = specificationsData.filter(d => selectedDocIds.has(d.id)).reduce((sum, d) => sum + d.total_pages, 0);
              return (
                <>
                  <div className="token-estimate">
                    <span>選択資料の合計ページ数: </span>
                    <strong>{activePages} ページ</strong>
                  </div>
                  {activePages > 120 && !isDemoMode && !autoFilter ? (
                    <div className="context-warning error animate-fade-in">
                      ⚠️ ページ数が多すぎます。自動抽出が無効なため、制限エラー（Quota Exceeded）が発生する可能性が極めて高いです。資料を外すか、自動抽出を有効にしてください。
                    </div>
                  ) : activePages > 120 && !isDemoMode && autoFilter ? (
                    <div className="context-warning info animate-fade-in">
                      💡 自動抽出が有効なため、質問に関連する上位20ページのみが送信されます。制限を気にせずご利用いただけます。
                    </div>
                  ) : null}
                </>
              );
            })()}
          </div>
        </section>

        {/* Center Panel: Chat QA Arena */}
        <section className="panel-chat glass-panel">
          <div className="panel-header">
            <Sparkles size={18} className="icon-aqua" />
            <h2>施工要領 QA チャット</h2>
          </div>

          {errorMsg && (
            <div className="error-banner animate-fade-in">
              <div className="error-banner-content">
                <AlertTriangle size={16} className="error-icon" />
                <span className="error-text">{errorMsg}</span>
              </div>
              <button className="error-close-btn" onClick={() => setErrorMsg(null)}>
                ✕
              </button>
            </div>
          )}

          <div className="chat-messages scrollable">
            {chatHistory.length === 0 ? (
              <div className="chat-welcome animate-fade-in">
                <div className="welcome-icon">💧</div>
                <h3>東京都水道局 施工要領 AI へようこそ</h3>
                <p>施工要領のPDFデータ全体（最大1.5MB、約270ページ）がロードされています。疑問点や詳細な施工手順、提出手続きなどについて質問してください。</p>
                
                {isDemoMode && (
                  <div style={{ background: 'rgba(20, 184, 166, 0.1)', border: '1px solid var(--color-secondary)', padding: '12px', borderRadius: '8px', width: '100%', margin: '10px 0', fontSize: '12.5px', color: 'var(--color-secondary-hover)' }}>
                    ℹ️ 現在<strong>デモモード</strong>で動作しています。よくある質問例をクリックすると、設定不要で施工要領に基づいた模範回答をお試しいただけます。
                  </div>
                )}

                <div className="welcome-suggestions">
                  <h4>💡 よくある質問例</h4>
                  <div className="suggestions-grid">
                    {defaultQuestions.map((q, idx) => (
                      <button 
                        key={idx} 
                        className="suggestion-card"
                        onClick={() => handleSendQuestion(q.text)}
                      >
                        <span className="tag">{q.tag}</span>
                        <p>{q.text}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              chatHistory.map(msg => (
                <div key={msg.id} className={`message-bubble ${msg.role}`}>
                  <div className="message-avatar">
                    {msg.role === 'user' ? 'U' : 'AI'}
                  </div>
                  <div className="message-content-wrapper">
                    <div className="message-meta">
                      <span className="sender">{msg.role === 'user' ? 'あなた' : '施工要領アシスタント'}</span>
                      <span className="time">{msg.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    </div>
                    <div className="message-body">
                      {msg.role === 'user' ? (
                        <p>{msg.parts[0].text}</p>
                      ) : (
                        <Markdown
                          options={{
                            overrides: {
                              a: {
                                component: 'a',
                                props: {
                                  target: '_blank',
                                  rel: 'noopener noreferrer'
                                }
                              }
                            }
                          }}
                        >
                          {linkifyCitations(msg.parts[0].text, specificationsData)}
                        </Markdown>
                      )}
                    </div>
                    {msg.role === 'model' && msg.references && msg.references.length > 0 && (
                      <div className="message-references">
                        <div className="ref-title">🔍 参照元資料 (クリックで開く):</div>
                        <div className="ref-tags">
                          {msg.references.map((ref, idx) => {
                            const doc = specificationsData.find(d => d.title === ref.docTitle);
                            const docUrl = doc ? doc.url : '#';
                            return (
                              <div key={idx} className="ref-group-container">
                                <span className="ref-doc-label" title={ref.docTitle}>{ref.docTitle}:</span>
                                <div className="ref-page-links">
                                  {ref.pages.map((pNum, pIdx) => {
                                    const page = doc?.pages.find(p => p.page_number === pNum);
                                    const pageLabel = doc ? getPageLabel(doc.id, pNum, page?.text || '') : `p. ${pNum}`;
                                    const linkUrl = docUrl !== '#' ? `${docUrl}#page=${pNum}` : '#';
                                    return (
                                      <a
                                        key={pIdx}
                                        href={linkUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ref-page-link-tag"
                                        title={`${ref.docTitle} の ${pageLabel} を開く`}
                                      >
                                        {pageLabel}
                                      </a>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {msg.role === 'model' && (
                      <div className="message-actions">
                        <button 
                          className="action-btn-small" 
                          onClick={() => handlePinMessage(msg)}
                          title="ノートへピン留め"
                        >
                          <Pin size={12} />
                          <span>ノートにピン留め</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            
            {isGenerating && (
              <div className="message-bubble model generating">
                <div className="message-avatar animate-pulse">AI</div>
                <div className="message-content-wrapper">
                  <div className="message-meta">
                    <span className="sender">施工要領アシスタント</span>
                    <span className="time">考えています...</span>
                  </div>
                  <div className="message-body">
                    <div className="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form className="chat-input-area" onSubmit={(e) => { e.preventDefault(); handleSendQuestion(userInput); }}>
            <input 
              type="text" 
              placeholder={apiKey ? "施工要領について質問を入力..." : isDemoMode ? "デモモード動作中。よくある質問例をクリックするか、質問を入力..." : "右上の設定からGemini APIキーを入力してください..."}
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              disabled={isGenerating || (!apiKey && !isDemoMode)}
            />
            <button 
              type="submit" 
              className="send-btn" 
              disabled={isGenerating || !userInput.trim() || (!apiKey && !isDemoMode)}
            >
              <Send size={16} />
            </button>
          </form>
        </section>

        {/* Right Side: Notes and Notebook Section */}
        <section className="panel-notes glass-panel">
          <div className="panel-header">
            <FileText size={18} className="icon-teal" />
            <h2>学習ノート・メモ</h2>
          </div>

          <div className="new-note-form">
            <input 
              type="text" 
              placeholder="ノートタイトル（例: 給水管の深さ）" 
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
            />
            <textarea 
              placeholder="重要なポイント、メモを入力..." 
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
            />
            <button className="add-note-btn" onClick={handleAddNote}>
              <Plus size={16} />
              <span>メモを追加</span>
            </button>
          </div>

          <div className="notes-actions-bar">
            <button 
              className="notes-action-btn secondary"
              onClick={handleGenerateStudyGuide}
              disabled={notes.length === 0 || isGeneratingStudyGuide}
              title="ノートを元にAIが体系的な学習ガイドを作成します"
            >
              {isGeneratingStudyGuide ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              <span>AI学習ガイド作成</span>
            </button>
            <button 
              className="notes-action-btn primary"
              onClick={handleExportNotes}
              disabled={notes.length === 0}
              title="ノートをMarkdownファイルとしてダウンロード"
            >
              <Download size={14} />
              <span>ノート出力</span>
            </button>
          </div>

          <div className="notes-list scrollable">
            {notes.length === 0 ? (
              <div className="notes-empty animate-fade-in">
                <FileText size={32} />
                <p>保存されたノートはありません。</p>
                <p className="subText">質問への回答で「ノートにピン留め」を押すか、上のフォームからメモを書いて保存できます。</p>
              </div>
            ) : (
              notes.map(note => (
                <div key={note.id} className="note-card animate-fade-in">
                  <div className="note-card-header">
                    <h4>{note.title}</h4>
                    <button className="delete-btn" onClick={() => handleDeleteNote(note.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="note-card-body">
                    <Markdown>{note.content}</Markdown>
                  </div>
                  <div className="note-card-footer">
                    <span>{new Date(note.timestamp).toLocaleDateString()} {new Date(note.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/* API Key Configurations Modal */}
      {showKeyModal && (
        <div className="modal-overlay animate-fade-in">
          <div className="modal-content glass-panel animate-fade-in">
            <div className="modal-header">
              <Key size={20} className="icon-blue" />
              <h3>Gemini APIキーの設定</h3>
            </div>
            <div className="modal-body">
              <p>このアプリケーションは、施工要領のPDF情報に対するインテリジェントな質問対応と要約の生成に **Gemini API** を使用します。</p>
              <p className="hint">APIキーはブラウザの `localStorage` にのみ保存され、直接GoogleのAPIエンドポイントに送信されます。外部サーバーには一切送信されません。</p>
              
              <div className="input-group">
                <label>Gemini API Key</label>
                <input 
                  type="password" 
                  placeholder="AIzaSy..." 
                  value={tempKey}
                  onChange={(e) => setTempKey(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label>使用するモデル (Model)</label>
                <select 
                  value={tempModel}
                  onChange={(e) => setTempModel(e.target.value)}
                  className="model-select-dropdown"
                >
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (標準・高速)</option>
                  <option value="gemini-3.5-flash">Gemini 3.5 Flash (最新・高速・推奨)</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro (高性能・混雑回避用)</option>
                </select>
              </div>

              <div className="key-guide">
                <p>💡 APIキーをお持ちでない場合は、<a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a> から無料で数秒で取得できます。</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="btn-demo" 
                onClick={() => {
                  setIsDemoMode(true);
                  localStorage.setItem('is_demo_mode', 'true');
                  setShowKeyModal(false);
                }}
              >
                デモモードで試す
              </button>
              {apiKey && (
                <button className="btn-cancel" onClick={() => { setTempKey(apiKey); setShowKeyModal(false); }}>
                  キャンセル
                </button>
              )}
              <button className="btn-save" onClick={handleSaveKey}>
                <Check size={16} />
                <span>保存する</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
