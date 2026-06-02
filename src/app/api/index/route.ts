/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { Document } from "@langchain/core/documents";
import { PineconeInferenceEmbeddings } from "@/lib/embeddings";
import fs from "fs";
import path from "path";
import { supabase } from "@/lib/supabase";

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
    const body = await req.json().catch(() => ({}));
    const { pineconeApiKey } = body;
    const apiKey = pineconeApiKey || process.env.PINECONE_API_KEY;
    const host = process.env.PINECONE_HOST;
    
    if (!apiKey) {
      return NextResponse.json(
        { error: "PINECONE_API_KEY environment variable is missing" },
        { status: 500 }
      );
    }

    // 1. Read and parse CSV file
    const csvPath = path.join(process.cwd(), "samples", "review.csv");
    if (!fs.existsSync(csvPath)) {
      return NextResponse.json(
        { error: "Sample review.csv file not found at c:\\shopping_chat\\samples\\review.csv" },
        { status: 404 }
      );
    }
    
    const csvContent = fs.readFileSync(csvPath, "utf8");
    const parsedReviews = parseCSV(csvContent);
    
    if (parsedReviews.length === 0) {
      return NextResponse.json(
        { error: "No reviews parsed from the CSV file" },
        { status: 400 }
      );
    }

    // 2. Initialize Pinecone client
    const pc = new Pinecone({ apiKey });
    const indexName = "review-chatbot";

    // 3. Ensure Index exists (if not, create it)
    try {
      const indexList = await pc.listIndexes();
      const exists = indexList.indexes?.some((idx) => idx.name === indexName);
      
      if (!exists) {
        console.log(`Creating index ${indexName}...`);
        await pc.createIndex({
          name: indexName,
          dimension: 1024,
          metric: "cosine",
          spec: {
            serverless: {
              cloud: "aws",
              region: "us-east-1"
            }
          }
        });
        // Wait for serverless index readiness
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (e) {
      console.warn("Index check/creation failed or skipped:", e);
    }

    // Target the index
    const index = host ? pc.index(indexName, host) : pc.index(indexName);

    // 4. Construct LangChain Documents
    const documents = parsedReviews.map((rev) => {
      // Content format to optimize semantic matches
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
          original_content: rev.content // preserve pure content
        }
      });
    });

    // 5. Upsert reviews to Supabase Table for raw database visibility
    console.log("Upserting reviews to Supabase...");
    try {
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
        console.warn("Supabase reviews upsert failed (will continue with Pinecone):", dbError);
      } else {
        console.log(`Successfully upserted ${parsedReviews.length} reviews to Supabase.`);
      }
    } catch (e) {
      console.warn("Error upserting to Supabase:", e);
    }

    // 6. Initialize custom LangChain Embeddings with llama-text-embed-v2
    const embeddings = new PineconeInferenceEmbeddings({ apiKey });

    // 6. Write to Vector Database using LangChain PineconeStore
    console.log("Upserting documents to Pinecone...");
    await PineconeStore.fromDocuments(documents, embeddings, {
      pineconeIndex: index
    });

    return NextResponse.json({
      success: true,
      message: `Successfully indexed ${documents.length} reviews from review.csv into Pinecone index '${indexName}' using llama-text-embed-v2.`
    });
  } catch (error: any) {
    console.error("Indexing API Error:", error);
    return NextResponse.json(
      { error: error.message || "An error occurred during indexing" },
      { status: 500 }
    );
  }
}
