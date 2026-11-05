import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'

/**
 * @param revision Changes when the list of tasks changes. The mutations update the list in place
 * and do not refetch, so this is what tells the summary to load again.
 */
export function useTodoSummaryQuery(revision: number) {
  return useQuery({
    queryKey: [...todoKeys.summary, revision],
    queryFn: ({ signal }) => todosApi.summary(signal),
    placeholderData: keepPreviousData,
  })
}
