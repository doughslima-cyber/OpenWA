import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usersApi, type UserInput } from '../services/users';
import type { UserRole } from '../types/role';

const USERS_KEY = ['users'] as const;

export function useUsersQuery() {
  return useQuery({ queryKey: USERS_KEY, queryFn: usersApi.list, staleTime: 30_000 });
}

function useUsersMutation<V, R>(fn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

export function useCreateUserMutation() {
  return useUsersMutation((data: { name: string; email: string; password: string; role: UserRole }) =>
    usersApi.create(data),
  );
}

export function useUpdateUserMutation() {
  return useUsersMutation(({ id, data }: { id: string; data: Omit<UserInput, 'email'> }) => usersApi.update(id, data));
}

export function useDeleteUserMutation() {
  return useUsersMutation((id: string) => usersApi.delete(id));
}
