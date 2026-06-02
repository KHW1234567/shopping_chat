/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { PineconeInferenceEmbeddings } from "@/lib/embeddings";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { Document } from "@langchain/core/documents";
import { supabase } from "@/lib/supabase";
import fs from "fs";
import path from "path";

// Helper CSV parser
function parseCSV(csvText: string) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(",");
  const results = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const row: string[] = [];
    let insideQuote = false;
    let currentField = "";
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      
      if (char === '"') {
        if (insideQuote && line[j + 1] === '"') {
          currentField += '"';
          j++; // skip next quote
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === ',' && !insideQuote) {
        row.push(currentField);
        currentField = "";
      } else {
        currentField += char;
      }
    }
    row.push(currentField);
    
    if (row.length >= headers.length) {
      results.push({
        id: row[0],
        rating: parseInt(row[1], 10) || 5,
        title: row[2],
        content: row[3],
        author: row[4],
        date: row[5],
        helpful_votes: parseInt(row[6], 10) || 0,
        verified_purchase: row[7] === 'true'
      });
    }
  }
  return results;
}

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    
    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "Query parameter 'query' is required and must be a string." },
        { status: 400 }
      );
    }

    const apiKey = process.env.PINECONE_API_KEY;
    const host = process.env.PINECONE_HOST;

    if (!apiKey) {
      return NextResponse.json(
        { error: "PINECONE_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    // 1. Initialize Pinecone client
    const pc = new Pinecone({ apiKey });
    const indexName = "review-chatbot";
    const index = host ? pc.index(indexName, host) : pc.index(indexName);

    // 2. Initialize Embeddings wrapper
    const embeddings = new PineconeInferenceEmbeddings({ apiKey });

    // 3. Initialize LangChain PineconeStore & Perform similarity search
    const vectorStore = new PineconeStore(embeddings, {
      pineconeIndex: index
    });

    console.log(`Searching Pinecone for query: "${query}"`);
    let results = await vectorStore.similaritySearch(query, 3); // Get top 3 matches

    // Check if reviews need seeding (either Pinecone has 0 results, or Supabase has 0 reviews, or no REV- id matches)
    let needsSeeding = false;
    try {
      const { count } = await supabase
        .from("reviews")
        .select("*", { count: "exact", head: true });
      if (count === 0 || count === null) {
        needsSeeding = true;
      }
    } catch (e) {
      console.warn("Failed to check Supabase reviews count:", e);
    }

    const hasRealReviews = results.some((doc) => doc.metadata && String(doc.metadata.id || "").startsWith("REV-"));
    if (!hasRealReviews) {
      console.log("No actual reviews ('REV-*') found in Pinecone search results. Triggering auto-seed.");
      needsSeeding = true;
    }

    if (results.length === 0 || needsSeeding) {
      console.log("No reviews or vector index found. Automatically seeding reviews from review.csv into Pinecone and Supabase...");
      try {
        const csvPath = path.join(process.cwd(), "samples", "review.csv");
        if (fs.existsSync(csvPath)) {
          const csvContent = fs.readFileSync(csvPath, "utf8");
          const parsedReviews = parseCSV(csvContent);
          
          if (parsedReviews.length > 0) {
            // 1. Auto-seed Supabase reviews table
            console.log("Auto-seeding Supabase reviews table...");
            const { error: dbError } = await supabase
              .from("reviews")
              .upsert(
                parsedReviews.map((rev) => ({
                  id: rev.id,
                  rating: rev.rating,
                  title: rev.title,
                  content: rev.content,
                  author: rev.author,
                  date: rev.date,
                  helpful_votes: rev.helpful_votes,
                  verified_purchase: rev.verified_purchase
                }))
              );
            
            if (dbError) {
              console.warn("Auto-seeding Supabase warning (will continue with Pinecone):", dbError);
            }

            // 2. Auto-seed Pinecone vector index
            console.log("Auto-seeding Pinecone vector index...");
            const documents = parsedReviews.map((rev) => {
              const pageContent = `[리뷰 내용] ${rev.content}\n[제목] ${rev.title}\n[평점] ${rev.rating}점\n[작성자] ${rev.author}`;
              return new Document({
                pageContent,
                metadata: {
                  id: rev.id,
                  rating: rev.rating,
                  title: rev.title,
                  author: rev.author,
                  date: rev.date,
                  helpful_votes: rev.helpful_votes,
                  verified_purchase: rev.verified_purchase,
                  original_content: rev.content
                }
              });
            });

            await PineconeStore.fromDocuments(documents, embeddings, {
              pineconeIndex: index
            });

            console.log("Auto-seeding successfully completed. Re-running similarity search...");
            results = await vectorStore.similaritySearch(query, 3);
          }
        }
      } catch (seedError) {
        console.error("Auto-seeding failed:", seedError);
      }
    }

    if (results.length === 0) {
      // Final fallback response if index is still empty after auto-seeding
      return NextResponse.json({
        text: "현재 데이터베이스에 관련한 리뷰 데이터가 발견되지 않았습니다. 원본 csv 파일을 확인해 주세요.",
        sentiment: {
          label: "검색 결과 없음",
          percentage: 0
        },
        references: []
      });
    }

    // 4. Calculate dynamic sentiment from search results
    const positiveCount = results.filter((doc) => (doc.metadata.rating || 5) >= 4).length;
    const positivePct = Math.round((positiveCount / results.length) * 100);

    // 5. Generate RAG Answer text using OpenAI gpt-5-nano via LangChain
    const openAIApiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
    if (!openAIApiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not configured in the server environment (.env)." },
        { status: 500 }
      );
    }

    const chatModel = new ChatOpenAI({
      openAIApiKey,
      modelName: "gpt-5-nano"
    });

    const reviewContext = results.map((doc, idx) => (
      `리뷰 #${idx + 1}\n` +
      `제목: ${doc.metadata.title}\n` +
      `내용: ${doc.metadata.original_content || doc.pageContent}\n` +
      `평점: ${doc.metadata.rating}점\n` +
      `작성자: ${doc.metadata.author}`
    )).join("\n\n");

    const systemPrompt = "당신은 쇼핑 리뷰 분석 전문가 AI입니다. 사용자가 입력한 상품에 대해 제공된 실제 사용자 리뷰 데이터를 기반으로 객관적이고 구체적인 분석 정보를 한국어로 친절하게 제공해야 합니다. 분석 결과를 제공할 때 핵심 호평과 유의할 점을 명확히 요약해 주세요.";
    const userPrompt = `사용자 질문: "${query}"\n\n제공된 리뷰 데이터:\n${reviewContext}\n\n위 리뷰 데이터를 기반으로 질문에 대해 성실하고 객관적으로 답변해 주세요.`;

    let synthesisText = "";
    try {
      const responseFromModel = await chatModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt)
      ]);
      synthesisText = String(responseFromModel.content);
    } catch (modelError: any) {
      console.error("OpenAI invocation failed, using fallback synthesis:", modelError);
      const positiveReviews = results.filter((doc) => (doc.metadata.rating || 5) >= 4);
      const criticalReviews = results.filter((doc) => (doc.metadata.rating || 5) <= 3);

      synthesisText = `질문하신 내용에 대해 Pinecone 벡터 데이터베이스에서 관련 구매 후기 ${results.length}건을 검색하여 실시간 분석해 드립니다.\n\n`;
      synthesisText += `분석 결과, 검색된 리뷰 중 약 **${positivePct}%의 사용자**가 해당 부분에 대해 긍정적인 반응을 보였습니다.\n\n`;
      
      if (positiveReviews.length > 0) {
        synthesisText += `**주요 호평 내용:**\n`;
        positiveReviews.forEach(doc => {
          synthesisText += `- "${doc.metadata.title}": ${doc.metadata.original_content}\n`;
        });
        synthesisText += `\n`;
      }

      if (criticalReviews.length > 0) {
        synthesisText += `**유의해야 할 의견:**\n`;
        criticalReviews.forEach(doc => {
          synthesisText += `- "${doc.metadata.title}": ${doc.metadata.original_content}\n`;
        });
        synthesisText += `\n`;
      }
      synthesisText += `이러한 데이터 분석 결과를 바탕으로 최적의 선택에 도움되시길 바랍니다.`;
    }

    // 6. Map vectors to match front-end references state
    const references = results.map((doc) => ({
      author: doc.metadata.author || "사용자",
      rating: doc.metadata.rating || 5,
      content: doc.metadata.original_content || doc.pageContent,
      tag: doc.metadata.title || "Review Topic"
    }));

    return NextResponse.json({
      text: synthesisText,
      sentiment: {
        label: `${query.substring(0, 10)} 관련 만족도`,
        percentage: positivePct
      },
      references
    });
  } catch (error: any) {
    console.error("Search API Error:", error);
    return NextResponse.json(
      { error: error.message || "An error occurred during search" },
      { status: 500 }
    );
  }
}
