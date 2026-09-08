/** Shared table pager: ‹ / › buttons + mono caption. Hidden when one page. */
export function Pager({
  page,
  pageCount,
  total,
  unit = "models",
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  unit?: string;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button
        type="button"
        className="bench-btn bench-btn--sm"
        aria-label="Previous page"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </button>
      <span className="pager__cap">
        page {page + 1} / {pageCount} · {total} {unit}
      </span>
      <button
        type="button"
        className="bench-btn bench-btn--sm"
        aria-label="Next page"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        ›
      </button>
    </div>
  );
}
