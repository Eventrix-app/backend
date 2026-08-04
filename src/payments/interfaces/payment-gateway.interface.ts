export interface PaymentOrderInput {
  enrollmentId: string;
  userId: string;
  amount: number;
  currency: string;
  description: string;
}

export interface PaymentOrderResult {
  orderId: string;
  amount: number;
  currency: string;
  keyId?: string;
  transactionId?: string;
  hash?: string;
  actionUrl?: string;
}

export interface RefundInput {
  mihpayid?: string;
  paymentId?: string;
  amount: number;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
}

export interface IPaymentGateway {
  readonly gatewayName: string;
  refundTransaction(input: RefundInput): Promise<RefundResult>;
}
