// =============================================================================
// Typed shapes for the subset of the Microsoft Graph v1.0 API we consume
// (app-only mail read for the shared support mailbox). Only the fields the
// acknowledgement ingestion reads are modelled.
// =============================================================================

export interface GraphTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: { emailAddress?: GraphEmailAddress } | null;
  sentDateTime?: string | null; // ISO-8601
  receivedDateTime?: string | null; // ISO-8601
}

export interface GraphMessagesResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
}
