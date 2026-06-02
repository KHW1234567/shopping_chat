/* eslint-disable @typescript-eslint/no-explicit-any */
import { Embeddings, EmbeddingsParams } from "@langchain/core/embeddings";
import { Pinecone } from "@pinecone-database/pinecone";

export interface PineconeInferenceEmbeddingsParams extends EmbeddingsParams {
  apiKey: string;
  model?: string;
}

export class PineconeInferenceEmbeddings extends Embeddings {
  private client: Pinecone;
  private model: string;

  constructor(fields: PineconeInferenceEmbeddingsParams) {
    super(fields);
    this.client = new Pinecone({ apiKey: fields.apiKey });
    this.model = fields.model || "llama-text-embed-v2";
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    console.log(`embedDocuments called with ${documents.length} documents.`);
    if (documents.length === 0) return [];
    
    const batchSize = 50; // Stay safely under Pinecone's limit of 96 inputs
    const results: number[][] = [];
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const chunk = documents.slice(i, i + batchSize);
      console.log(`Generating embeddings for batch: documents ${i + 1} to ${Math.min(i + batchSize, documents.length)}...`);
      
      const result = await this.client.inference.embed(
        this.model,
        chunk,
        { inputType: "passage" }
      );
      
      console.log(`Pinecone API raw result keys:`, Object.keys(result || {}));
      const embeddings = result.data?.map((r: any) => r.values || []) || [];
      console.log(`Successfully generated ${embeddings.length} embeddings for this batch.`);
      results.push(...embeddings);
    }
    
    console.log(`embedDocuments returning total of ${results.length} embeddings.`);
    return results;
  }

  async embedQuery(document: string): Promise<number[]> {
    const result = await this.client.inference.embed(
      this.model,
      [document],
      { inputType: "query" }
    );
    
    return (result.data?.[0] as any)?.values || [];
  }
}
