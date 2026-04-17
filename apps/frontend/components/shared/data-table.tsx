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
  selectedRowKey?: string | null;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyTitle = "표시할 데이터가 없습니다.",
  emptyDescription = "조건을 바꾸거나 백엔드 연결 상태를 확인해 주세요.",
  caption,
  selectedRowKey,
  onRowClick,
}: DataTableProps<T>) {
  return (
    <div className="table-scroll">
      <table className="w-full border-collapse text-left">
        {caption ? (
          <caption className="sr-only">{caption}</caption>
        ) : null}
        <thead className="sticky top-0 z-20 bg-[var(--bg)]">
          <tr className="border-b border-ink/10 text-xs tracking-tight text-ink/70">
            {columns.map((column) => (
              <th key={column.key} className={cn("px-3 py-3 font-medium", column.className)}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                className="px-3 py-10 text-center text-sm text-ink/60"
                colSpan={columns.length}
              >
                <div className="mx-auto max-w-lg">
                  <p className="font-medium text-ink">{emptyTitle}</p>
                  <p className="mt-2 leading-6 text-ink/60">{emptyDescription}</p>
                </div>
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const rowKey = getRowKey(row);
              const isSelected = selectedRowKey === rowKey;
              return (
                <tr
                  key={rowKey}
                  className={cn(
                    "border-b border-ink/8 text-sm text-ink transition cursor-pointer",
                    isSelected
                      ? "bg-[rgba(201,106,74,0.08)] border-l-4 border-l-[var(--accent)]"
                      : "hover:bg-white/60",
                  )}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn("px-3 py-3 align-top", column.className)}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
