import axios, { AxiosInstance } from "axios";
import { config } from "../config";

/**
 * TxLINE devnet API client.
 * Long-lived X-Api-Token from .env; short-lived guest JWT renewed on 401.
 */
class TxlineClient {
  private jwt = config.initialJwt;
  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({ baseURL: config.apiBaseUrl });

    this.http.interceptors.request.use((req) => {
      if (this.jwt) req.headers["Authorization"] = `Bearer ${this.jwt}`;
      req.headers["X-Api-Token"] = config.apiToken;
      return req;
    });

    this.http.interceptors.response.use(
      (res) => res,
      async (error) => {
        const original = error.config;
        if (error.response?.status === 401 && !original._retry) {
          original._retry = true;
          await this.renewJwt();
          return this.http(original);
        }
        return Promise.reject(error);
      }
    );
  }

  get currentJwt(): string {
    return this.jwt;
  }

  async renewJwt(): Promise<string> {
    const res = await axios.post(config.guestStartUrl);
    this.jwt = res.data.token;
    console.log("[auth] guest JWT renewed");
    return this.jwt;
  }

  // --- data endpoints ---

  async fixturesSnapshot(params?: Record<string, string | number>) {
    const res = await this.http.get("/fixtures/snapshot", { params });
    return res.data;
  }

  async oddsSnapshot(fixtureId: number, asOf?: number) {
    const url = `/odds/snapshot/${fixtureId}` + (asOf ? `?asOf=${asOf}` : "");
    const res = await this.http.get(url);
    return res.data;
  }

  async oddsValidation(messageId: string, ts: number) {
    const res = await this.http.get("/odds/validation", { params: { messageId, ts } });
    return res.data;
  }

  async fixtureValidation(fixtureId: number, timestamp: number) {
    const res = await this.http.get("/fixtures/validation", { params: { fixtureId, timestamp } });
    return res.data;
  }
}

export const txline = new TxlineClient();
