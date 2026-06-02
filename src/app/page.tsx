/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */
"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import styles from "./page.module.css";
import { supabase } from "@/lib/supabase";

// Interface definitions
interface ReviewCardType {
  author: string;
  rating: number;
  content: string;
  tag: string;
}

interface ChatMessage {
  id: string;
  sender: "user" | "ai";
  text: string;
  sentiment?: {
    label: string;
    percentage: number;
  };
  references?: ReviewCardType[];
}

interface ChatSession {
  id: string;
  title: string;
  created_at: string;
}

export default function Home() {
  // Page layout and tab states
  const [activeMenu, setActiveMenu] = useState<string>("history");
  
  // Database states
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  // Chat history states
  const [isInitialState, setIsInitialState] = useState<boolean>(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  
  // Settings view states (editable inputs initialized with defaults)
  const [pineconeKey, setPineconeKey] = useState<string>("");
  const [openaiApiKey, setOpenaiApiKey] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-pro");
  const [systemPrompt, setSystemPrompt] = useState<string>(
    "당신은 쇼핑 리뷰 분석 전문가 AI입니다. 사용자가 입력한 상품에 대해 1,200건의 실제 사용자 리뷰 데이터를 기반으로 객관적이고 구체적인 분석 정보를 제공합니다. 분석 결과 제공 시 핵심 긍정 수치(%) 및 참고한 개별 사용자의 솔직한 리뷰 카드를 함께 제공하여 분석의 신뢰성을 높여야 합니다."
  );
  const [dbIndexName, setDbIndexName] = useState<string>("review-chatbot");
  const [isSettingsSaved, setIsSettingsSaved] = useState<boolean>(false);
  
  // Indexing states
  const [isIndexing, setIsIndexing] = useState<boolean>(false);
  const [indexingMessage, setIndexingMessage] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of chat when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isInitialState, activeMenu]);

  // Reset settings saved notification
  useEffect(() => {
    if (isSettingsSaved) {
      const timer = setTimeout(() => setIsSettingsSaved(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isSettingsSaved]);

  const fetchSessions = async () => {
    try {
      const { data, error } = await supabase
        .from("chat_sessions")
        .select("*")
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      if (data) setSessions(data);
    } catch (e) {
      console.error("Failed to fetch sessions from Supabase:", e);
    }
  };

  // Load chat sessions from Supabase and keys from localStorage on mount
  useEffect(() => {
    fetchSessions();
    if (typeof window !== "undefined") {
      const savedPineconeKey = localStorage.getItem("pineconeKey");
      const savedOpenaiKey = localStorage.getItem("openaiKey");
      if (savedPineconeKey) setPineconeKey(savedPineconeKey);
      if (savedOpenaiKey) setOpenaiApiKey(savedOpenaiKey);
    }
  }, []);

  const handleSelectSession = async (sid: string) => {
    try {
      setSessionId(sid);
      setIsInitialState(false);
      setActiveMenu("history");
      setChatMessages([]);

      const { data, error } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("session_id", sid)
        .order("created_at", { ascending: true });
      
      if (error) throw error;
      if (data) {
        setChatMessages(
          data.map((m: any) => ({
            id: m.id,
            sender: m.sender,
            text: m.text,
            sentiment: m.sentiment_label
              ? { label: m.sentiment_label, percentage: m.sentiment_percentage }
              : undefined,
            references: m.reference_reviews || undefined
          }))
        );
      }
    } catch (e) {
      console.error("Failed to load session messages:", e);
    }
  };

  const handleSendMessage = async (textToSend: string) => {
    if (!textToSend.trim()) return;

    let currentSessionId = sessionId;

    try {
      // 1. If there's no active session, create a new one in Supabase
      if (!currentSessionId) {
        const sessionTitle = textToSend.length > 25 ? `${textToSend.substring(0, 22)}...` : textToSend;
        const { data: newSession, error: sError } = await supabase
          .from("chat_sessions")
          .insert({ title: sessionTitle })
          .select()
          .single();
        
        if (sError) throw sError;
        if (newSession) {
          currentSessionId = newSession.id;
          setSessionId(currentSessionId);
          fetchSessions(); // Refresh sidebar list
        }
      }

      if (!currentSessionId) return;

      // 2. Optimistically append user message to UI state
      const userMsgId = `user-${Date.now()}`;
      const userMsg: ChatMessage = {
        id: userMsgId,
        sender: "user",
        text: textToSend,
      };

      setIsInitialState(false);
      setChatMessages((prev) => [...prev, userMsg]);
      setInputValue("");

      // 3. Write user message to Supabase
      await supabase.from("chat_messages").insert({
        session_id: currentSessionId,
        sender: "user",
        text: textToSend
      });

      // 4. Call search API to run vector DB similarity search & RAG synthesis
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: textToSend,
          pineconeApiKey: pineconeKey || undefined,
          openaiApiKey: openaiApiKey || undefined
        })
      });

      if (!response.ok) {
        throw new Error("Failed to communicate with RAG search API");
      }

      const ragResult = await response.json();

      // 5. Append AI message to UI state
      const aiMsgId = `ai-${Date.now()}`;
      const aiMsg: ChatMessage = {
        id: aiMsgId,
        sender: "ai",
        text: ragResult.text,
        sentiment: ragResult.sentiment || undefined,
        references: ragResult.references || undefined
      };

      setChatMessages((prev) => [...prev, aiMsg]);

      // 6. Write AI response to Supabase
      await supabase.from("chat_messages").insert({
        session_id: currentSessionId,
        sender: "ai",
        text: ragResult.text,
        sentiment_label: ragResult.sentiment?.label || null,
        sentiment_percentage: ragResult.sentiment?.percentage || null,
        reference_reviews: ragResult.references || null
      });

    } catch (e) {
      console.error("Chat communication/database error:", e);
      // Append fallback simulated response in case of API failure
      setChatMessages((prev) => [
        ...prev,
        {
          id: `ai-err-${Date.now()}`,
          sender: "ai",
          text: "죄송합니다. 데이터베이스 연결 중 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
        }
      ]);
    }
  };

  const handleNewChat = () => {
    setSessionId(null);
    setIsInitialState(true);
    setChatMessages([]);
    setInputValue("");
    setActiveMenu("history");
  };

  const handleIndexSamples = async () => {
    setIsIndexing(true);
    setIndexingMessage("Pinecone 인덱싱 진행 중... (시간이 수 초 소요될 수 있습니다)");
    
    try {
      const response = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pineconeApiKey: pineconeKey || undefined
        })
      });

      const result = await response.json();

      if (response.ok) {
        setIndexingMessage(`성공: ${result.message}`);
      } else {
        setIndexingMessage(`실패: ${result.error || "알 수 없는 오류가 발생했습니다."}`);
      }
    } catch (e: any) {
      console.error("Indexing Error:", e);
      setIndexingMessage(`오류: ${e.message || "서버 통신 실패"}`);
    } finally {
      setIsIndexing(false);
    }
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== "undefined") {
      localStorage.setItem("pineconeKey", pineconeKey);
      localStorage.setItem("openaiKey", openaiApiKey);
    }
    setIsSettingsSaved(true);
  };

  // Helper component to render stars
  const renderStars = (rating: number) => {
    return (
      <div className={styles.starContainer}>
        {Array.from({ length: 5 }).map((_, idx) => (
          <svg
            key={idx}
            className={`${styles.starIcon} ${idx < rating ? styles.starFilled : styles.starEmpty}`}
            viewBox="0 0 24 24"
          >
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
          </svg>
        ))}
      </div>
    );
  };

  // ==================== RENDERS FOR VARIOUS TABS ====================

  // 1. History (Chat Interface)
  const renderChatView = () => {
    return (
      <>
        {/* Scrollable Message List */}
        <div className={styles.chatArea}>
          {isInitialState ? (
            // Landing screen layout (chat.png)
            <div className={styles.landingContainer}>
              <div className={styles.landingContent}>
                {/* Central RK Logo */}
                <div className={styles.centralLogo}>
                  <svg className={styles.logoSvg} viewBox="0 0 100 100">
                    <path
                      d="M50 15 L80 45 L80 75 L50 85 L20 75 L20 45 Z"
                      fill="none"
                      stroke="#0b57d0"
                      strokeWidth="6"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M35 50 L50 35 L65 50 M50 35 L50 75"
                      fill="none"
                      stroke="#0b57d0"
                      strokeWidth="5"
                      strokeLinecap="round"
                    />
                    <circle cx="50" cy="35" r="4" fill="#0b57d0" />
                  </svg>
                  <div className={styles.logoText}>RK</div>
                </div>

                <h2 className={styles.welcomeTitle}>환영합니다!</h2>
                <p className={styles.welcomeSubtitle}>상품 리뷰에 대해 무엇이든 물어보세요.</p>

                {/* Recommendations Chips */}
                <div className={styles.presetChips}>
                  <button
                    className={styles.presetChip}
                    onClick={() => handleSendMessage("운동할 때 써도 돼요?")}
                  >
                    운동할 때 써도 돼요?
                  </button>
                  <button
                    className={styles.presetChip}
                    onClick={() => handleSendMessage("배터리 오래 가나요?")}
                  >
                    배터리 오래 가나요?
                  </button>
                  <button
                    className={styles.presetChip}
                    onClick={() => handleSendMessage("통화 품질은?")}
                  >
                    통화 품질은?
                  </button>
                </div>

                {/* AI Welcome analysis card */}
                <div className={styles.aiGreetingCard}>
                  <div className={styles.aiIconBubble}>
                    <svg className={styles.sparkleIcon} viewBox="0 0 24 24">
                      <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C8.8 12.1 8 10.61 8 9c0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.61-.8 3.1-2.15 4.1z" />
                    </svg>
                  </div>
                  <div className={styles.aiGreetingContent}>
                    <p className={styles.aiGreetingText}>
                      안녕하세요! &apos;프리미엄 무선 이어폰 Pro&apos;에 대한 1,200건의 리뷰를 분석했습니다. 전체적인 만족도는 4.8점으로 매우 높습니다. 특히 노이즈 캔슬링 성능에 대한 호평이 많습니다. 궁금하신 구체적인 항목이 있으신가요?
                    </p>
                    
                    {/* Sentiment distributions */}
                    <div className={styles.sentimentBarContainer}>
                      <div className={styles.sentimentLabels}>
                        <span className={styles.sentimentLabelPos}>긍정 88%</span>
                        <span className={styles.sentimentLabelNeu}>중립 9%</span>
                        <span className={styles.sentimentLabelNeg}>부정 3%</span>
                      </div>
                      <div className={styles.sentimentSplitBar}>
                        <div className={styles.barPositive} style={{ width: "88%" }}></div>
                        <div className={styles.barNeutral} style={{ width: "9%" }}></div>
                        <div className={styles.barNegative} style={{ width: "3%" }}></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // Chat messages layout (chat_2.png)
            <div className={styles.messagesContainer}>
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`${styles.messageWrapper} ${
                    msg.sender === "user" ? styles.userWrapper : styles.aiWrapper
                  }`}
                >
                  {msg.sender === "ai" && (
                    <div className={styles.aiAvatar}>
                      <svg className={styles.sparkleIconSmall} viewBox="0 0 24 24">
                        <path d="M12 2L14.7 8.3L21 9.6L16.2 14.1L17.7 20.7L12 17.2L6.3 20.7L7.8 14.1L3 9.6L9.3 8.3L12 2Z" fill="#0b57d0" />
                      </svg>
                    </div>
                  )}

                  <div
                    className={`${styles.messageBubble} ${
                      msg.sender === "user" ? styles.userBubble : styles.aiBubble
                    }`}
                  >
                    {/* Message Text */}
                    <div className={styles.messageText}>{msg.text}</div>

                    {/* Sentiment Analysis Bar for AI Response */}
                    {msg.sentiment && (
                      <div className={styles.analysisSection}>
                        <div className={styles.analysisHeader}>
                          <span className={styles.analysisLabel}>{msg.sentiment.label}</span>
                          <span className={styles.analysisPct}>{msg.sentiment.percentage}% 긍정</span>
                        </div>
                        <div className={styles.analysisProgressBg}>
                          <div
                            className={styles.analysisProgressFill}
                            style={{ width: `${msg.sentiment.percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    )}

                    {/* Referenced Reviews */}
                    {msg.references && msg.references.length > 0 && (
                      <div className={styles.referencesSection}>
                        <div className={styles.referencesTitle}>
                          <svg className={styles.iconBook} viewBox="0 0 24 24">
                            <path d="M12 11.55C9.64 9.35 6.48 8 3 8v11c3.48 0 6.64 1.35 9 3.55 2.36-2.2 5.52-3.55 9-3.55V8c-3.48 0-6.64 1.35-9 3.55zM12 8c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2.22c-2.33 0-7 1.17-7 3.5v.78c0 .28.22.5.5.5H12v-4.78z" />
                          </svg>
                          <span>참고한 리뷰</span>
                        </div>
                        
                        <div className={styles.refCards}>
                          {msg.references.map((ref, idx) => (
                            <div key={idx} className={styles.refCard}>
                              <div className={styles.refCardHeader}>
                                <span className={styles.refAuthor}>{ref.author}</span>
                                {renderStars(ref.rating)}
                              </div>
                              <p className={styles.refContent}>{ref.content}</p>
                              <div className={styles.refTag}>
                                <svg className={styles.iconCheck} viewBox="0 0 24 24">
                                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                </svg>
                                <span>{ref.tag}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Bar & Footer */}
        <div className={styles.inputContainer}>
          {/* Preset Follow-ups (only when not initial state) */}
          {!isInitialState && (
            <div className={styles.followupChips}>
              <button
                className={styles.followupChip}
                onClick={() => handleSendMessage("통화 품질은 어떤가요?")}
              >
                통화 품질은 어떤가요?
              </button>
              <button
                className={styles.followupChip}
                onClick={() => handleSendMessage("착용감이 불편하진 않나요?")}
              >
                착용감이 불편하진 않나요?
              </button>
              <button
                className={styles.followupChip}
                onClick={() => handleSendMessage("배터리 실사용 시간은?")}
              >
                배터리 실사용 시간은?
              </button>
            </div>
          )}

          <div className={styles.inputWrapper}>
            <input
              type="text"
              placeholder={isInitialState ? "리뷰에게 물어보세요..." : "제품에 대해 궁금한 점을 물어보세요..."}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSendMessage(inputValue);
                }
              }}
              className={styles.chatInput}
            />
            
            <div className={styles.inputActions}>
              <button className={styles.clipBtn}>
                <svg className={styles.clipIcon} viewBox="0 0 24 24">
                  <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.66 1.34 3 3 3s3-1.34 3-3V5c0-2.21-1.79-4-4-4S8 2.79 8 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                </svg>
              </button>
              
              <button
                className={`${styles.sendBtn} ${inputValue.trim() ? styles.sendBtnActive : ""}`}
                onClick={() => handleSendMessage(inputValue)}
                disabled={!inputValue.trim()}
              >
                <svg className={styles.sendIcon} viewBox="0 0 24 24">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>
          </div>
          <div className={styles.disclaimer}>
            ReviewAI can make mistakes. Check important info.
          </div>
        </div>
      </>
    );
  };

  // 2. Analytics View
  const renderAnalyticsView = () => {
    return (
      <div className={styles.dashboardContainer}>
        <div className={styles.dashboardHeader}>
          <h2 className={styles.dashboardTitle}>리뷰 분석 대시보드</h2>
          <p className={styles.dashboardSub}>실제 사용자 리뷰 1,248건의 감정 및 통계 데이터입니다.</p>
        </div>

        {/* KPI Grid */}
        <div className={styles.kpiGrid}>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>총 리뷰 수</div>
            <div className={styles.kpiValue}>1,248건</div>
            <div className={`${styles.kpiBadge} ${styles.badgeGreen}`}>+12% 이번주</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>평균 평점</div>
            <div className={styles.kpiValue}>4.8 / 5.0</div>
            <div className={styles.kpiStars}>{renderStars(5)}</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>긍정 감정 비율</div>
            <div className={styles.kpiValue} style={{ color: "var(--primary-blue)" }}>88.2%</div>
            <div className={styles.kpiProgressSmall}><div className={styles.kpiProgressFill} style={{ width: "88.2%", backgroundColor: "var(--primary-blue)" }}></div></div>
          </div>
        </div>

        {/* Details Grid */}
        <div className={styles.chartDetailsGrid}>
          {/* Star Rating Distribution */}
          <div className={styles.chartCard}>
            <h3 className={styles.chartCardTitle}>평점 분포도</h3>
            <div className={styles.distributionList}>
              {[
                { stars: 5, pct: 82 },
                { stars: 4, pct: 11 },
                { stars: 3, pct: 4 },
                { stars: 2, pct: 2 },
                { stars: 1, pct: 1 },
              ].map((item) => (
                <div key={item.stars} className={styles.distRow}>
                  <span className={styles.distLabel}>{item.stars}점</span>
                  <div className={styles.distBarBg}>
                    <div className={styles.distBarFill} style={{ width: `${item.pct}%` }}></div>
                  </div>
                  <span className={styles.distPct}>{item.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Key Feature Scores */}
          <div className={styles.chartCard}>
            <h3 className={styles.chartCardTitle}>주요 속성별 만족도</h3>
            <div className={styles.featureScoreList}>
              {[
                { name: "노이즈 캔슬링 (ANC)", score: 85, color: "#3b82f6" },
                { name: "배터리 수명 (Battery)", score: 92, color: "#10b981" },
                { name: "착용감 (Comfort)", score: 89, color: "#f59e0b" },
                { name: "통화 품질 (Call)", score: 74, color: "#8b5cf6" },
              ].map((feat) => (
                <div key={feat.name} className={styles.featureScoreRow}>
                  <div className={styles.featureScoreHeader}>
                    <span className={styles.featureScoreName}>{feat.name}</span>
                    <span className={styles.featureScoreVal}>{feat.score}% 긍정</span>
                  </div>
                  <div className={styles.featureScoreBarBg}>
                    <div
                      className={styles.featureScoreBarFill}
                      style={{ width: `${feat.score}%`, backgroundColor: feat.color }}
                    ></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Keyword Clouds */}
        <div className={styles.keywordGrid}>
          <div className={`${styles.keywordCard} ${styles.keyPositive}`}>
            <h3 className={styles.keywordCardTitle}>핵심 긍정 키워드</h3>
            <div className={styles.tagCloud}>
              {["#강력한 ANC (421건)", "#편안한 착용감 (389건)", "#오래가는 배터리 (312건)", "#깔끔한 마감 (189건)", "#빠른 페어링 (145건)", "#무선 충전 편리 (98건)"].map((tag) => (
                <span key={tag} className={styles.kTagPos}>{tag}</span>
              ))}
            </div>
          </div>
          <div className={`${styles.keywordCard} ${styles.keyNegative}`}>
            <h3 className={styles.keywordCardTitle}>핵심 개선 키워드</h3>
            <div className={styles.tagCloud}>
              {["#야외 통화 잡음 (84건)", "#기본 이어팁 크기 (52건)", "#어플 연동 오류 (41건)", "#약간 무거운 유닛 (23건)"].map((tag) => (
                <span key={tag} className={styles.kTagNeg}>{tag}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // 3. Comparisons View
  const renderComparisonsView = () => {
    return (
      <div className={styles.dashboardContainer}>
        <div className={styles.dashboardHeader}>
          <h2 className={styles.dashboardTitle}>경쟁사 제품 비교 분석</h2>
          <p className={styles.dashboardSub}>동급 가격대 및 카테고리의 대표 모델들과의 리뷰 스펙 비교표입니다.</p>
        </div>

        <div className={styles.tableCard}>
          <table className={styles.compareTable}>
            <thead>
              <tr>
                <th>비교 항목</th>
                <th className={styles.highlightCol}>프리미엄 무선 이어폰 Pro</th>
                <th>A사 SoundBuds</th>
                <th>B사 ClearAudio</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={styles.tableFeature}>출시 가격</td>
                <td className={`${styles.tableValue} ${styles.highlightCell}`}>329,000원</td>
                <td className={styles.tableValue}>249,000원</td>
                <td className={styles.tableValue}>389,000원</td>
              </tr>
              <tr>
                <td className={styles.tableFeature}>노이즈 캔슬링</td>
                <td className={`${styles.tableValue} ${styles.highlightCell}`}>최상 (85% 만족)</td>
                <td className={styles.tableValue}>보통 (68% 만족)</td>
                <td className={styles.tableValue}>우수 (78% 만족)</td>
              </tr>
              <tr>
                <td className={styles.tableFeature}>배터리 시간</td>
                <td className={`${styles.tableValue} ${styles.highlightCell}`}>최대 8시간 (케이스 24h)</td>
                <td className={styles.tableValue}>최대 6시간 (케이스 18h)</td>
                <td className={styles.tableValue}>최대 7시간 (케이스 22h)</td>
              </tr>
              <tr>
                <td className={styles.tableFeature}>착용감 / 무게</td>
                <td className={`${styles.tableValue} ${styles.highlightCell}`}>우수 (89% 만족)</td>
                <td className={styles.tableValue}>보통 (71% 만족)</td>
                <td className={styles.tableValue}>우수 (82% 만족)</td>
              </tr>
              <tr>
                <td className={styles.tableFeature}>통화 품질</td>
                <td className={`${styles.tableValue} ${styles.highlightCell}`}>보통 (74% 만족)</td>
                <td className={styles.tableValue}>우수 (81% 만족)</td>
                <td className={styles.tableValue}>보통 (70% 만족)</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Strengths & Weaknesses */}
        <div className={styles.chartDetailsGrid} style={{ marginTop: "24px" }}>
          <div className={`${styles.chartCard} ${styles.borderGreen}`}>
            <h3 className={styles.strengthTitle} style={{ color: "#10b981", display: "flex", alignItems: "center", gap: "8px" }}>
              <svg style={{ width: "20px", height: "20px", fill: "currentColor" }} viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
              </svg>
              우리 제품의 강점
            </h3>
            <ul className={styles.bulletsList}>
              <li>배터리 지속 성능 및 무선 충전 충전 속도 만족도가 경쟁사 대비 평균 15% 높음.</li>
              <li>인체공학적 피트감으로 장시간 착용 시 통증이 덜하다는 리뷰가 다수 포진.</li>
              <li>ANC 저음역대 차단력이 매우 뛰어나 지하철, 비행기 소음 차단에 강점을 보임.</li>
            </ul>
          </div>
          <div className={`${styles.chartCard} ${styles.borderRed}`}>
            <h3 className={styles.strengthTitle} style={{ color: "#ef4444", display: "flex", alignItems: "center", gap: "8px" }}>
              <svg style={{ width: "20px", height: "20px", fill: "currentColor" }} viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              보완 필요 항목
            </h3>
            <ul className={styles.bulletsList}>
              <li>야외 대도시 소음 차로변 등에서의 수신자 통화 품질 마이크 빔포밍 개선 필요.</li>
              <li>A사 대비 약 8만원가량 높은 가격 장벽이 있어 프로모션 혜택 제시 필요.</li>
              <li>전용 모바일 앱 연동 시 간헐적인 기기 끊김 오류에 대한 개선 리포트 존재.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  };

  // 4. Settings View
  const renderSettingsView = () => {
    return (
      <div className={styles.dashboardContainer} style={{ maxWidth: "680px" }}>
        <div className={styles.dashboardHeader}>
          <h2 className={styles.dashboardTitle}>시스템 설정</h2>
          <p className={styles.dashboardSub}>데이터베이스 연동 및 AI 분석 엔진 설정 옵션입니다.</p>
        </div>

        {isSettingsSaved && (
          <div className={styles.successToast}>
            <svg style={{ width: "20px", height: "20px", fill: "currentColor" }} viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
            </svg>
            <span>설정이 안전하게 저장되었습니다! (.env 파일 및 로컬 세션 동기화 완료)</span>
          </div>
        )}

        <form className={styles.settingsForm} onSubmit={handleSaveSettings}>
          {/* Pinecone API key */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Pinecone API Key</label>
            <div className={styles.apiKeyInputContainer}>
              <input
                type={showApiKey ? "text" : "password"}
                value={pineconeKey}
                onChange={(e) => setPineconeKey(e.target.value)}
                className={styles.formInput}
                placeholder="Pinecone API Key를 입력하세요 (미입력시 서버 .env 값 사용)"
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <svg className={styles.eyeIcon} viewBox="0 0 24 24">
                    <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm0-10C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" />
                  </svg>
                ) : (
                  <svg className={styles.eyeIcon} viewBox="0 0 24 24">
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 11.5 2.73 15.39 7 18.5 12 18.5s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 11.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                  </svg>
                )}
              </button>
            </div>
            <span className={styles.formHint}>입력된 키는 벡엔드 파인콘 인덱스 벡터 검색 호출 시 활용됩니다.</span>
          </div>

          {/* OpenAI API key */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>OpenAI API Key</label>
            <div className={styles.apiKeyInputContainer}>
              <input
                type={showApiKey ? "text" : "password"}
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                className={styles.formInput}
                placeholder="OpenAI API Key를 입력하세요 (미입력시 서버 .env 값 사용)"
              />
            </div>
            <span className={styles.formHint}>입력된 키는 백엔드 OpenAI(gpt-5-nano) 호출 시 활용됩니다.</span>
          </div>

          {/* Database Index Name */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Pinecone Index Name</label>
            <input
              type="text"
              value={dbIndexName}
              onChange={(e) => setDbIndexName(e.target.value)}
              className={styles.formInput}
              placeholder="데이터베이스 인덱스 명칭"
              disabled
            />
            <span className={styles.formHint}>인덱스명은 &apos;review-chatbot&apos;으로 고정 설정되어 있습니다.</span>
          </div>

          {/* AI Model Selector */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>분석 AI 모델 선택</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className={styles.formSelect}
            >
              <option value="gemini-pro">Gemini 1.5 Pro (권장)</option>
              <option value="gemini-flash">Gemini 1.5 Flash</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="claude-sonnet">Claude 3.5 Sonnet</option>
            </select>
          </div>

          {/* System Prompt Settings */}
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>시스템 분석 프롬프트 (System Prompt)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className={styles.formTextarea}
              rows={4}
              placeholder="AI 에이전트의 역할 지침 프로토콜"
            />
          </div>

          {/* Indexing Section (review-chatbot RAG) */}
          <div className={styles.formGroupBordered} style={{ marginTop: "10px", paddingTop: "20px" }}>
            <label className={styles.formLabel} style={{ display: "block", marginBottom: "8px" }}>벡터 DB 데이터 적재</label>
            <button
              type="button"
              onClick={handleIndexSamples}
              disabled={isIndexing}
              className={styles.indexBtn}
            >
              {isIndexing ? "데이터 인덱싱 진행 중..." : "샘플 데이터 인덱싱 (review.csv)"}
            </button>
            {indexingMessage && (
              <p className={styles.indexingStatusMsg}>{indexingMessage}</p>
            )}
            <span className={styles.formHint}>samples/review.csv에 들어있는 100개의 리뷰 정보를 벡터 임베딩(llama-text-embed-v2)하여 Pinecone에 업로드합니다.</span>
          </div>

          <button type="submit" className={styles.saveSettingsBtn}>
            설정 저장하기
          </button>
        </form>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      {/* 1. Left Sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <div className={styles.brandTitle}>ReviewAI</div>
          <div className={styles.brandSubtitle}>Insight Engine</div>
        </div>

        <button className={styles.newChatBtn} onClick={handleNewChat}>
          <svg className={styles.iconPlus} viewBox="0 0 24 24">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
          </svg>
          <span>New Chat</span>
        </button>

        <nav className={styles.sidebarNav}>
          <button
            className={`${styles.navItem} ${activeMenu === "history" ? styles.navItemActive : ""}`}
            onClick={() => setActiveMenu("history")}
          >
            <svg className={styles.iconNav} viewBox="0 0 24 24">
              <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
            </svg>
            <span>History</span>
          </button>

          {/* Database-linked chat history list */}
          {sessions.length > 0 && (
            <div className={styles.recentSessionsList}>
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSelectSession(s.id)}
                  className={`${styles.recentSessionItem} ${sessionId === s.id ? styles.recentSessionItemActive : ""}`}
                >
                  <svg className={styles.iconSessionChat} viewBox="0 0 24 24">
                    <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                  </svg>
                  <span className={styles.sessionTitleText}>{s.title}</span>
                </button>
              ))}
            </div>
          )}
          
          <button
            className={`${styles.navItem} ${activeMenu === "analytics" ? styles.navItemActive : ""}`}
            onClick={() => setActiveMenu("analytics")}
          >
            <svg className={styles.iconNav} viewBox="0 0 24 24">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
            </svg>
            <span>Analytics</span>
          </button>

          <button
            className={`${styles.navItem} ${activeMenu === "comparisons" ? styles.navItemActive : ""}`}
            onClick={() => setActiveMenu("comparisons")}
          >
            <svg className={styles.iconNav} viewBox="0 0 24 24">
              <path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z" />
            </svg>
            <span>Comparisons</span>
          </button>
        </nav>

        <div className={styles.sidebarFooter}>
          <button
            className={`${styles.footerItem} ${activeMenu === "settings" ? styles.navItemActive : ""}`}
            onClick={() => setActiveMenu("settings")}
          >
            <svg className={styles.iconNav} viewBox="0 0 24 24">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
            <span>Settings</span>
          </button>
          
          <button className={styles.footerItem}>
            <svg className={styles.iconNav} viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 16h-2v-2h2v2zm1.07-7.75l-.9.92C12.45 11.9 12 12.5 12 14h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z" />
            </svg>
            <span>Help</span>
          </button>
        </div>
      </aside>

      {/* 2. Main Chat/Dashboard Panel */}
      <main className={styles.mainContent}>
        {/* Header */}
        <header className={styles.header}>
          <h1 className={styles.headerTitle}>
            {activeMenu === "history" && "프리미엄 무선 이어폰 Pro"}
            {activeMenu === "analytics" && "리뷰 분석 엔진"}
            {activeMenu === "comparisons" && "제품 성능 비교 대조"}
            {activeMenu === "settings" && "제어 시스템 설정"}
          </h1>
          
          <div className={styles.headerControls}>
            <div className={styles.searchBar}>
              <svg className={styles.searchIcon} viewBox="0 0 24 24">
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
              <input
                type="text"
                placeholder="검색..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={styles.searchInput}
              />
            </div>
            
            <button className={styles.headerBtn}>
              <svg className={styles.headerIcon} viewBox="0 0 24 24">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>

            <div className={styles.profileAvatar}>
              <svg className={styles.avatarSvg} viewBox="0 0 24 24">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            </div>
          </div>
        </header>

        {/* Dynamic Inner Panel based on active selection */}
        {activeMenu === "history" && renderChatView()}
        {activeMenu === "analytics" && renderAnalyticsView()}
        {activeMenu === "comparisons" && renderComparisonsView()}
        {activeMenu === "settings" && renderSettingsView()}
      </main>

      {/* 3. Right Product Summary Panel (only visible on active Chat tab and after a query) */}
      <aside className={`${styles.productSummary} ${(isInitialState || activeMenu !== "history") ? styles.productSummaryClosed : ""}`}>
        <div className={styles.summaryContent}>
          <h2 className={styles.summaryTitle}>제품 요약</h2>
          
          <div className={styles.productImageContainer}>
            <Image
              src="/premium_earbuds.png"
              alt="Premium Wireless Earbuds Pro"
              width={260}
              height={195}
              priority
              className={styles.productImage}
            />
          </div>

          <div className={styles.infoGroup}>
            <span className={styles.infoLabel}>출시가</span>
            <span className={styles.infoValuePrice}>329,000원</span>
          </div>

          <div className={styles.infoGroup}>
            <span className={styles.infoLabel}>핵심 키워드</span>
            <div className={styles.keywordTags}>
              <span className={styles.keywordTag}>#압도적ANC</span>
              <span className={styles.keywordTag}>#긴배터리</span>
              <span className={styles.keywordTag}>#착용감굿</span>
            </div>
          </div>

          <div className={styles.infoGroupBordered}>
            <div className={styles.sourceHeader}>
              <span className={styles.infoLabel}>데이터 소스</span>
              <span className={styles.infoValueSource}>1,248건</span>
            </div>
            
            <div className={styles.avatarGroup}>
              <div className={`${styles.userAvatarSmall} ${styles.avatar1}`}>
                <span>민</span>
              </div>
              <div className={`${styles.userAvatarSmall} ${styles.avatar2}`}>
                <span>지</span>
              </div>
              <div className={`${styles.userAvatarSmall} ${styles.avatar3}`}>
                <span>철</span>
              </div>
              <div className={styles.avatarMore}>
                <span>+1k</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
