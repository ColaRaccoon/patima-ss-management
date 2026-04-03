import { cn } from "@/lib/cn";

export interface DataTableColumn<T> {
  key: string;
  title: string;
  className?: string;
  render: (row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  caption?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyTitle = "표시할 데이터가 없습니다.",
  emptyDescription = "조건을 바꾸거나 백엔드 연결 상태를 확인해 주세요.",
  caption,
}: DataTableProps<T>) {
  return (
    <div className="table-scroll">
      <table className="w-full border-collapse text-left">
        {caption ? (
          <caption className="sr-only">{caption}</caption>
        ) : null}
        <thead>
          <tr className="border-b border-ink/10 text-xs uppercase tracking-[0.18em] text-ink/45">
            {columns.map((column) => (
              <th key={column.key} className="px-4 py-3 font-medium">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                className="px-4 py-10 text-center text-sm text-ink/60"
                colSpan={columns.length}
              >
                <div className="mx-auto max-w-lg">
                  <p className="font-medium text-ink">{emptyTitle}</p>
                  <p className="mt-2 leading-6 text-ink/60">{emptyDescription}</p>
                </div>
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={getRowKey(row)}
                className="border-b border-ink/8 text-sm text-ink transition hover:bg-white/45"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn("px-4 py-4 align-top", column.className)}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
