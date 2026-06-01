import type { PaginationResult } from "@patima/shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CONDITION_PARAM_TOKEN = "{param}";

export interface SqlQueryParts {
  text: string;
  params: unknown[];
}

export interface NormalizedPagination {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

export type SqlConditionTemplate = string | ((placeholder: string) => string);

export interface SqlBuilder {
  readonly params: readonly unknown[];
  readonly conditions: readonly string[];
  addParam(value: unknown): string;
  addCondition(condition: string): void;
  addCondition(condition: SqlConditionTemplate, value: unknown): void;
  whereClause(prefix?: string): string;
  build(text: string): SqlQueryParts;
  buildPaginated(text: string, pagination: NormalizedPagination): SqlQueryParts;
}

export const normalizePagination = (
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): NormalizedPagination => {
  const normalizedPage = Math.max(1, page);
  const normalizedPageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, pageSize),
  );

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    limit: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
};

export const buildPaginationResult = <T>(
  items: T[],
  totalCount: number,
  pagination: NormalizedPagination,
): PaginationResult<T> => {
  const totalPages = Math.max(1, Math.ceil(totalCount / pagination.pageSize));

  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalCount,
    totalPages,
    hasNext: pagination.page < totalPages,
    items,
  };
};

const applyConditionParam = (condition: string, placeholder: string): string => {
  if (!condition.includes(CONDITION_PARAM_TOKEN)) {
    throw new Error("SQL_CONDITION_PARAM_TOKEN_MISSING");
  }

  return condition.split(CONDITION_PARAM_TOKEN).join(placeholder);
};

export const createSqlBuilder = (): SqlBuilder => {
  const params: unknown[] = [];
  const conditions: string[] = [];

  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  function addCondition(condition: string): void;
  function addCondition(condition: SqlConditionTemplate, value: unknown): void;
  function addCondition(condition: SqlConditionTemplate, value?: unknown): void {
    if (arguments.length < 2) {
      if (typeof condition !== "string") {
        throw new Error("SQL_CONDITION_VALUE_REQUIRED");
      }
      if (condition.includes(CONDITION_PARAM_TOKEN)) {
        throw new Error("SQL_CONDITION_VALUE_REQUIRED");
      }

      conditions.push(condition);
      return;
    }

    const placeholder = addParam(value);
    const sql =
      typeof condition === "function"
        ? condition(placeholder)
        : applyConditionParam(condition, placeholder);

    conditions.push(sql);
  }

  const whereClause = (prefix = "WHERE"): string => {
    if (conditions.length === 0) {
      return "";
    }

    const joined = conditions.join(" AND ");
    return prefix ? `${prefix} ${joined}` : joined;
  };

  const build = (text: string): SqlQueryParts => ({
    text,
    params: [...params],
  });

  const buildPaginated = (
    text: string,
    pagination: NormalizedPagination,
  ): SqlQueryParts => {
    const limitPlaceholder = `$${params.length + 1}`;
    const offsetPlaceholder = `$${params.length + 2}`;

    return {
      text: `${text} LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      params: [...params, pagination.limit, pagination.offset],
    };
  };

  return {
    get params() {
      return [...params];
    },
    get conditions() {
      return [...conditions];
    },
    addParam,
    addCondition,
    whereClause,
    build,
    buildPaginated,
  };
};
