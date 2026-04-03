import { Injectable } from "@nestjs/common";
import { Store } from "@patima/shared";

export interface EnvNaverCredential {
  source: "env";
  clientId: string;
  clientSecret: string;
  accountUid: string;
  channelNo: string;
  solutionId: string | null;
  callbackUrl: string | null;
}

@Injectable()
export class NaverCommerceConfigService {
  getEnvCredentialForStore(store: Store): EnvNaverCredential | null {
    const credential = this.getRawEnvCredential();
    if (!credential) {
      return null;
    }

    if (
      store.sellerAccountId !== credential.accountUid ||
      store.channelNo !== credential.channelNo
    ) {
      return null;
    }

    return credential;
  }

  getBootstrapStorePayload():
    | {
        name: string;
        sellerAccountId: string;
        channelNo: string;
        memo: string;
      }
    | null {
    const shouldBootstrap = (this.read("NAVER_BOOTSTRAP_STORE") ?? "false").toLowerCase() === "true";
    const credential = this.getRawEnvCredential();
    if (!shouldBootstrap || !credential) {
      return null;
    }

    return {
      name: this.read("NAVER_STORE_NAME") ?? "Naver Primary Store",
      sellerAccountId: credential.accountUid,
      channelNo: credential.channelNo,
      memo: "Bootstrapped from NAVER_* environment variables.",
    };
  }

  maskClientId(clientId: string): string {
    return `${clientId.slice(0, 8)}****`;
  }

  private getRawEnvCredential(): EnvNaverCredential | null {
    const clientId = this.read("NAVER_CLIENT_ID");
    const clientSecret = this.read("NAVER_CLIENT_SECRET");
    const accountUid = this.read("NAVER_ACCOUNT_UID");
    const channelNo = this.read("NAVER_CHANNEL_NO");

    if (!clientId || !clientSecret || !accountUid || !channelNo) {
      return null;
    }

    return {
      source: "env",
      clientId,
      clientSecret,
      accountUid,
      channelNo,
      solutionId: this.read("NAVER_SOLUTION_ID"),
      callbackUrl: this.read("NAVER_CALLBACK_URL"),
    };
  }

  private read(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
  }
}
