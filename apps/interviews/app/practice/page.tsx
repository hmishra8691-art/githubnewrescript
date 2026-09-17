import { cookies } from "next/headers";
import Link from "next/link";
import { MOCK_CATEGORIES, MOCK_CATEGORY_SAY, MOCK_TEMPLATES, mockTemplatesIn } from "@rescript/interviews";
import { SESSION_COOKIE_NAME, isFailure, signInUrl, userForSession } from "@/lib/auth";
import { StartPractice } from "@/components/StartPractice";

export const dynamic = "force-dynamic";

/**
 * THE PRACTICE SHELF.
 *
 * Every template here is code (`packages/interviews/src/mockLibrary.ts`);
 * pressing Start copies one into a project of the person's own and hands
 * them their candidate link. Watch → answer → transcribe → analyse → feedback.
 */
export default async function PracticePage() {
  const user = await userForSession(cookies().get(SESSION_COOKIE_NAME)?.value ?? null);
  if (isFailure(user)) {
    const href = signInUrl("/practice");
    return (
      <main className="wrap"><div className="card">
        <h1>Practice interviews</h1>
        <p>Sign in to start a practice interview. Your recordings are private to you and deleted after a day.</p>
        {href && <p><a className="btn" href={href}>Sign in</a></p>}
      </div></main>
    );
  }

  return (
    <main className="wrap wide">
      <p className="tiny muted"><Link href="/">← Your projects</Link></p>
      <h1 style={{ marginBottom: 4 }}>Practice interviews</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Pick one and start now. You are recorded, transcribed, and read against the requirements
        listed — then shown what you said well and what a stronger answer would have contained.
        Recordings are kept for 24 hours so you can download them, then deleted.
      </p>

      {MOCK_CATEGORIES.filter((c) => mockTemplatesIn(c).length > 0).map((c) => (
        <section key={c} className="card" data-testid="practice-category" data-category={c}>
          <h2 style={{ marginTop: 0 }}>{MOCK_CATEGORY_SAY[c]}</h2>
          {mockTemplatesIn(c).map((t) => (
            <div key={t.key} className="row" style={{ justifyContent: "space-between", gap: 14, alignItems: "flex-start", borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}
              data-testid="practice-template" data-key={t.key}>
              <div style={{ flex: 1 }}>
                <strong>{t.title}</strong>
                <span className="muted small"> · about {t.minutes} min · {t.questions.length} questions</span>
                <p className="small" style={{ margin: "4px 0 6px" }}>{t.blurb}</p>
                <p className="tiny muted" style={{ margin: 0 }}>
                  Assesses: {t.requirements.map((r) => r.title).join(" · ")}
                </p>
              </div>
              <StartPractice templateKey={t.key} />
            </div>
          ))}
        </section>
      ))}

      <p className="tiny muted">{MOCK_TEMPLATES.length} practice interviews across {MOCK_CATEGORIES.filter((c) => mockTemplatesIn(c).length > 0).length} areas.</p>
    </main>
  );
}
