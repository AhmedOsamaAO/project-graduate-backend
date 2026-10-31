import { Injectable } from '@nestjs/common';

export interface AppIdentity {
  readonly message: string;
}

@Injectable()
export class AppService {
  getHello(): AppIdentity {
    return { message: 'Hello World!' };
  }
}
