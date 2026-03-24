/**
 * Transport abstraction for API calls.
 * 
 * Allows swapping between glab CLI, direct HTTP, or other transports
 * without changing any consumer code.
 */

export interface Transport {
  /** Execute a REST GET request, returning raw JSON string */
  restGet(path: string): Promise<string>;

  /** Execute a paginated REST GET request, returning raw JSON string of a combined array */
  restGetPaginated(path: string): Promise<string>;

  /** Execute a GraphQL query, returning raw JSON string */
  graphql(query: string): Promise<string>;
}
