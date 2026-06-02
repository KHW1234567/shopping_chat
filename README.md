# 🎧 쇼핑 리뷰 분석 챗봇 (ReviewAI)

1,200건의 실제 사용자 구매 리뷰 데이터를 기반으로 객관적인 상품 분석 요약을 제공하는 **Retrieval-Augmented Generation (RAG) 챗봇 서비스**입니다. 

실시간 감정 분석 수치, 관련도 높은 개별 구매 후기 레코드를 함께 보여주며, 사용자 질문에 가장 최적화된 상품 정보 인사이트를 제공합니다.

---

## 🛠️ 기술 스택 및 기술 선정 이유

본 프로젝트는 대화형 인터페이스의 빠른 응답 속도, 의미 기반 리뷰 탐색, 대화 내역 영구 보존을 만족하기 위해 다음의 기술들로 구성되어 있습니다.

### 1. 프레임워크 & 라이브러리
* **Next.js 16 (App Router) & React 19**
  * **역할**: 웹 어플리케이션의 프론트엔드 UI 구축 및 백엔드 API 엔드포인트 제공.
  * **선정 이유**: 개발 편의성이 높은 React 기반 하에, 백엔드 서버 구축 없이 `/api/search`, `/api/index` 등 서버 단 API 라우트를 동일 코드베이스 내에서 손쉽게 개발할 수 있습니다. 또한 Turbopack 및 SSR 기능을 지원해 초기 로딩 속도와 최적화가 우수합니다.
* **Vanilla CSS (CSS Modules)**
  * **역할**: 사용자 인터페이스의 디자인 시스템 렌더링.
  * **선정 이유**: 외부 프레임워크 오버헤드 없이 빠르고 직관적으로 스타일링을 커스텀 정의할 수 있으며, CSS 네이밍 충돌 문제를 완벽히 배제해 경량화된 UI를 유지합니다.

### 2. AI & 벡터 엔지니어링
* **LangChain (JS/TS)**
  * **역할**: AI 모델 호출 및 벡터 스토어 통합 등을 돕는 챗봇 오케스트레이터.
  * **선정 이유**: LLM 프롬프트 템플릿 처리, Pinecone과의 유사도 검색 통합 흐름을 유연하게 제어하며, 향후 다양한 데이터 스토어나 프롬프트 엔진 교체 시 높은 확장성을 제공합니다.
* **OpenAI (gpt-5-nano)**
  * **역할**: Pinecone에서 검색해 온 리뷰 데이터를 종합 분석하여 최종 대화 답변을 생성하는 주 연산 모델.
  * **선정 이유**: 매우 가볍고 응답 속도가 대폭 향상된 최신 소형 모델로, 제한된 예산과 짧은 타임아웃 환경 내에서 대규모 리뷰 텍스트를 논리적이고 풍부하게 조합하여 실시간 RAG 분석을 신속히 수행합니다.
* **Pinecone (Vector DB)**
  * **역할**: 대형 비정형 리뷰 텍스트의 벡터 저장 및 의미 기반 유사도 검색 (Semantic Search).
  * **선정 이유**: 서버리스 환경에서 빠른 검색 응답 시간을 보장하며, Pinecone의 자체 내장 임베딩 생성(Inference API) 기능을 활용하여 클라이언트 리소스를 최소화하고 정확도 높은 코사인 유사도 검색을 수행합니다.
  * **임베딩 모델**: `llama-text-embed-v2` 모델을 이용하여 1024차원의 밀집 벡터를 생성하여 인덱싱합니다.

### 3. 데이터베이스 & 데이터 소스
* **Supabase (PostgreSQL)**
  * **역할**: 관계형 데이터(대화 내역, 세션 정보, 수집된 원본 리뷰 데이터)의 영구 보존.
  * **선정 이유**: PostgreSQL을 백엔드로 하여 견고한 보안 정책(RLS) 및 REST API 클라이언트를 바로 제공하므로, 클라이언트 측에서 별도의 서버 쿼리 없이 쉽고 빠르게 CRUD 작업을 수행할 수 있습니다.
* **Local CSV (`samples/review.csv`)**
  * **역할**: 쇼핑몰에서 수집된 100건의 고품질 구매 후기 원본 보관 및 업로드 기초 자료.

---

## 🏗️ 시스템 아키텍처 및 연동 흐름 (RAG Flow)

사용자가 대화창에서 질문을 전송하면 시스템은 다음과 같은 흐름으로 동작합니다:

```mermaid
sequenceDiagram
    actor User as 사용자
    participant Front as 프론트엔드 (page.tsx)
    participant Back as 백엔드 API (/api/search)
    database Supa as Supabase (PostgreSQL)
    database Pine as Pinecone (Vector DB)
    participant LLM as OpenAI (gpt-5-nano)

    User->>Front: 질문 입력 ("배터리 시간은 어때?")
    Front->>Supa: 사용자 질문 저장 (chat_messages)
    Front->>Back: RAG 검색 요청 (POST /api/search)
    Back->>Pine: 질문 벡터화 및 유사 리뷰 3건 검색
    
    alt 최초 1회 실행 (DB가 비어있을 때)
        Back-->>Back: review.csv 분석 후 Supabase & Pinecone에 자동 적재 (Auto-seeding)
        Back->>Pine: 다시 유사 리뷰 3건 검색
    end

    Pine-->>Back: 3건의 리뷰 매칭 데이터 반환
    Back->>LLM: 질문 + 3건의 리뷰 데이터를 프롬프트로 전달
    LLM-->>Back: 가공된 최종 분석 답변 생성
    Back-->>Front: 답변 + 감정 통계 수치 + 참고한 리뷰 객체 반환
    Front->>Supa: AI 응답 내용 저장 (chat_messages)
    Front-->>User: 화면 렌더링 (답변 카드, 긍정% 그래프, 참고 리뷰 리스트)
```

---

## ⚙️ 로컬 실행 및 설치 방법

### 1. 환경 변수 구성 (.env)
프로젝트 루트 폴더에 `.env` 파일을 생성하고 아래 키를 입력합니다.
```env
PINECONE_API_KEY=본인의_Pinecone_API_Key
PINECONE_HOST=본인의_Pinecone_Index_Host_Url
NEXT_PUBLIC_SUPABASE_URL=본인의_Supabase_프로젝트_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=본인의_Supabase_Publishable_Anon_Key
OPENAI_API_KEY=본인의_OpenAI_API_Key
```

### 2. 패키지 설치 및 빌드
```bash
# 의존성 패키지 설치 (피어 의존성 무시 옵션 포함)
npm install --legacy-peer-deps

# 개발용 로컬 서버 실행
npm run dev

# 프로덕션 빌드 검증
npm run build
```

### 3. 데이터베이스 테이블 생성 (마이그레이션 푸시)
Supabase CLI를 사용해 대화 및 리뷰 저장을 위한 테이블 스키마들을 데이터베이스에 구축합니다.
```bash
npx supabase db push --password "본인의_Supabase_DB_비밀번호"
```
*(명령어가 성공적으로 수행되면 Supabase의 Table Editor 화면에 `chat_sessions`, `chat_messages`, `reviews` 테이블이 생성됩니다.)*

### 4. 자동 연동 및 시작 (Auto-seeding)
* 번거로운 수동 업로드 작업 필요 없이, 웹 페이지(`http://localhost:3000`)에 접속하여 첫 질문을 전송하기만 하면 **자동으로 CSV 로컬 데이터를 Supabase와 Pinecone에 나누어 업로드**합니다.
* 최초 1회 자동 적재가 완료된 이후부터는 OpenAI의 `gpt-5-nano` 모델의 빠른 지능형 RAG 분석이 시작됩니다.
