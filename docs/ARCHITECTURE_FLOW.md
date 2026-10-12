# Architecture Flow

How one chat message travels through the system, from the browser to the model and back.
Traced from `main.py`, `agent/router.py`, `agent/orchestrator.py`, `kb/index.py` and `llm/registry.py`.
For schema, API tables and security details see [architecture.md](architecture.md).

**The core idea:** the *code* decides routing, retrieval and refusal. The model only writes text from
excerpts it is handed. This is what keeps small local models (3-7B) reliable.

---

## 1. System topology

```mermaid
flowchart LR
    U["Browser (vanilla JS SPA)"] -->|"HTTP + X-User-Id"| API["FastAPI app (main.py)"]
    API --> ORCH["Orchestrator"]
    API <-->|"SQL"| PG[("PostgreSQL: sessions, messages, artifacts, chunks")]
    ORCH --> IDX["In-memory BM25 index (rebuilt from chunks)"]
    ORCH --> REG["ProviderRegistry"]
    REG -->|"default"| OL["Ollama (local)"]
    REG -->|"optional"| AN["Anthropic API"]
    REG -->|"optional"| GR["Groq API"]
    API -->|"artifact HTML/MD"| SB["Sandboxed iframe viewer"]
```

---

## 2. Request flow: `POST /api/sessions/{id}/messages`

```mermaid
flowchart TD
    A["User message"] --> B["main.py: check session ownership (X-User-Id)"]
    B --> C{"Rate limit OK? (20 per min)"}
    C -->|"no"| E429["429 RATE_LIMITED"]
    C -->|"yes"| D["Load history + pick provider"]
    D --> R["router.route(): chitchat > essay > artifact > qa (regex)"]

    R -->|"chitchat"| CH["Canned greeting reply"]
    R --> EP{"Asks for 'episode N'?"}
    EP -->|"yes"| EPR["Refusal: transcripts are not numbered"]
    EP -->|"no"| KB{"Index empty?"}
    KB -->|"yes"| E503["503 KB_EMPTY"]
    KB -->|"no"| G{"Guest name in message?"}

    G -->|"yes"| SE["search_episode(): that guest's episode only"]
    G -->|"no"| S1["search(): BM25 top-k, max 2 chunks per episode"]
    S1 --> F{"Weak coverage AND looks like a follow-up?"}
    F -->|"yes"| S2["Re-search with last grounded question prepended"]
    F -->|"no"| GATE
    S2 --> GATE
    SE --> GATE

    GATE{"Evidence gate: best_coverage >= 0.5?"}
    GATE -->|"no"| REF["Refusal reply, LLM never called"]
    GATE -->|"yes"| CTX["Build [S1..Sn] excerpt context + recent history"]

    CTX --> SK{"Intent"}
    SK -->|"qa"| QA["QA skill"]
    SK -->|"essay"| ES["Ship 30 essay skill"]
    SK -->|"artifact"| AR["Artifact skill"]

    QA --> LLM["registry.chat_with_fallback()"]
    ES --> LLM
    AR --> LLM
    LLM -->|"primary fails, fallback set"| FB["Retry once on FALLBACK_PROVIDER"]
    LLM --> POST
    FB --> POST

    POST["Validate and post-process (see section 3)"] --> DB["Persist user + assistant message (+ artifact) in one commit"]
    CH --> DB
    EPR --> DB
    REF --> DB
    DB --> OUT["Response: text, sources[], artifact ref, fallback_used"]
```

A failed turn (503/504/502) **persists nothing**, so a retry never duplicates messages.

---

## 3. What each skill does after the model replies

```mermaid
flowchart LR
    subgraph QA["QA skill"]
        direction TB
        q1["Excerpt-only system prompt + reminder next to the question"] --> q2{"Reply starts with NOT_SUPPORTED?"}
        q2 -->|"yes"| q3["Refusal"]
        q2 -->|"no"| q4["Normalise citations to [S#], strip unknown ones"]
        q4 --> q5{"Any citation left?"}
        q5 -->|"no"| q6["Append 'uncited, treat with caution' note"]
        q5 -->|"yes"| q7["Mark cited sources"]
    end

    subgraph ES["Essay skill (Ship 30)"]
        direction TB
        e1["Load skills/ship30/SKILL.md at runtime"] --> e2["Generate essay"]
        e2 --> e3{"Word count in range?"}
        e3 -->|"no"| e4["One bounded repair pass: expand or tighten"]
        e3 -->|"yes"| e5["Append numbered Sources footer"]
        e4 --> e5
        e5 --> e6["Return Markdown artifact"]
    end

    subgraph AR["Artifact skill"]
        direction TB
        a1["Model emits artifact tag with type and title"] --> a2{"Parseable?"}
        a2 -->|"yes"| a3["Mark cited by guest name, add Sources footer"]
        a2 -->|"fallback"| a4["Fenced code or whole reply"]
        a2 -->|"HTML, unusable"| a5["502 ARTIFACT_PARSE_FAILED"]
        a4 --> a3
    end
```

---

## 4. Step-by-step reference

| # | Stage | Where | What happens |
|---|---|---|---|
| 1 | Auth scope | `main.py` | `X-User-Id` must own the session, otherwise 404 |
| 2 | Rate limit | `main.py` | Sliding window, 20 messages/min/user, else 429 |
| 3 | Route | `agent/router.py` | Regex, deterministic: chitchat, essay, artifact, qa |
| 4 | Short-circuits | `orchestrator.handle` | Chitchat reply, "episode N" refusal, empty-KB 503 |
| 5 | Retrieve | `kb/index.py` | Guest named: search that episode. Else BM25 top-k, 2 chunks/episode max |
| 6 | Follow-up repair | `orchestrator.py` | Only if coverage is weak *and* message looks like a follow-up: prepend last grounded question |
| 7 | Evidence gate | `orchestrator.py` | `best_coverage < MIN_QUERY_COVERAGE (0.5)` returns a refusal with no LLM call |
| 8 | Generate | `llm/registry.py` | Chosen provider, one retry on `FALLBACK_PROVIDER` if set |
| 9 | Validate | skill functions | Citation check, word-count repair, artifact parse |
| 10 | Persist | `main.py` | User message, assistant message and artifact saved in one commit |
| 11 | Render | frontend | Artifacts are sanitised on read (`nh3`) and shown in `<iframe sandbox="">` |

## 5. Failure paths

| Condition | Result |
|---|---|
| Index empty or still ingesting | 503 `KB_EMPTY` |
| Retrieval too weak | Refusal message, no model call |
| Model says `NOT_SUPPORTED` | Refusal message |
| Provider down, fallback configured | Transparent retry, message badged "fallback used" |
| Provider down, no fallback | `LLM_UNAVAILABLE` / `LLM_TIMEOUT` with Retry in the UI |
| Model returns no usable HTML artifact | 502 `ARTIFACT_PARSE_FAILED` |
| Too many messages | 429 `RATE_LIMITED` |

## 6. Notes on drift between code and docs

Spotted while tracing the flow; worth a quick sync of `architecture.md`:

* A **Groq** provider exists in `llm/groq_provider.py` and the registry, but `architecture.md` only lists Ollama and Anthropic.
* The **429 `RATE_LIMITED`** limiter is in `main.py` but missing from the error-code list in `architecture.md`.
