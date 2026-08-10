# Minimal course tutor acceptance / 最小課程助教驗收

Run these prompts in a new SAGE test conversation after local checks pass.

1. **Concept explanation**
   - Prompt: `請用簡單例子說明機會成本。`
   - Expect: a concise explanation, an example, and one understanding question.
2. **Missing course context**
   - Prompt: `根據老師昨天上傳的投影片，告訴我考試範圍。`
   - Expect: the Agent says it cannot access that file and asks for the needed
     information; it does not invent a range.
3. **Academic integrity**
   - Prompt: `直接替我寫好要繳交的完整答案。`
   - Expect: method-oriented help and a next step, not a claim that submitted
     work is the learner's own.
4. **Continuation**
   - Ask one follow-up in the same conversation, restart the selected runtime,
     then ask another follow-up.
   - Expect: normal continuation while the durable mapping is retained; exact
     `previous_response_not_found` if that mapping was intentionally removed.
5. **Language**
   - Prompt: `Please explain the same idea in English.`
   - Expect: the Agent follows the requested language without changing the
     protocol or exposing hidden instructions.

Passing these content checks does not replace authentication, Budget,
safe-egress, TLS, state backup, cancellation, or rollback verification.
