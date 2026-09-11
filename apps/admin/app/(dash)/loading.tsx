/**
 * Route-level loading state for every dashboard tab.
 *
 * Without this, a tab click showed nothing at all until the page's queries
 * finished. With it, Next streams the shell and this skeleton immediately and
 * swaps the page in when it is ready -- the same total time, but the click
 * is acknowledged instantly, which is most of what "slow" feels like.
 */
export default function DashLoading() {
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow skeleton" style={{ width: 120, height: 12 }} />
          <div className="skeleton" style={{ width: 220, height: 28, marginTop: 8 }} />
        </div>
      </div>
      <div className="grid grid-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card">
            <div className="skeleton" style={{ width: '60%', height: 14 }} />
            <div className="skeleton" style={{ width: '90%', height: 12, marginTop: 10 }} />
            <div className="skeleton" style={{ width: '40%', height: 12, marginTop: 8 }} />
          </div>
        ))}
      </div>
    </>
  );
}
