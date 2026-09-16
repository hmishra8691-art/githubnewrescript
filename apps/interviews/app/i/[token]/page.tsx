import { Interview } from "@/components/Interview";

export const dynamic = "force-dynamic";

/**
 * The candidate's door.
 *
 * `noindex` because the URL contains a bearer token and a search engine that
 * crawled one would publish a working link into somebody's interview. The
 * page itself is a shell: everything it needs comes from `/api/candidate/start`,
 * which authorizes the token server-side. Nothing about the interview is
 * rendered from the URL.
 */
export const metadata = {
  title: "Your interview",
  robots: { index: false, follow: false, nocache: true },
};

export default function CandidatePage({ params }: { params: { token: string } }) {
  return <Interview token={params.token} />;
}
