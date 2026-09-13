import type { Evidence } from "@/domain/contracts";

export interface IntegrationResult {
  evidence: Evidence[];
  errors: string[];
}

export interface ExternalActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface ExternalVerificationResult {
  verified: boolean;
  expectedState: string;
  actualState: string;
}