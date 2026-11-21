import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks an unauthenticated bootstrap or sign-in route exempted from the default-deny guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
