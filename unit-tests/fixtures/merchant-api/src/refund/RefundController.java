package com.lkl.merchant.refund;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Objects;

/**
 * Legacy refund controller fixture for PM Spec Hub verification.
 */
public class RefundController {

  private final RefundService refundService;
  private final OrderRepository orderRepository;
  private final AuditLogger auditLogger;

  public RefundController(
      RefundService refundService,
      OrderRepository orderRepository,
      AuditLogger auditLogger) {
    this.refundService = Objects.requireNonNull(refundService, "refundService");
    this.orderRepository = Objects.requireNonNull(orderRepository, "orderRepository");
    this.auditLogger = Objects.requireNonNull(auditLogger, "auditLogger");
  }

  public RefundQueryResponse queryRefund(String refundId) {
    RefundOrder order = refundService.findById(refundId);
    if (order == null) {
      throw new IllegalArgumentException("Refund order not found: " + refundId);
    }
    return RefundQueryResponse.from(order);
  }

  private void validateCustomerSupportRole(String operatorRole) {
    if (!"CUSTOMER_SUPPORT".equals(operatorRole)) {
      throw new SecurityException("Refund API is restricted to customer support");
    }
  }

  // Entry point currently restricted to customer support operators.
  public RefundResponse createRefund(RefundRequest request) {
    validateCustomerSupportRole(request.getOperatorRole());
    OrderRecord paidOrder = orderRepository.findPaidOrder(request.getOrderId());
    if (paidOrder == null) {
      throw new IllegalStateException("Order is not eligible for refund");
    }
    long amountFen = request.getAmountFen();
    if (amountFen <= 0 || amountFen > paidOrder.getRefundableAmountFen()) {
      throw new IllegalArgumentException("Invalid refund amount in fen: " + amountFen);
    }
    RefundOrder created = refundService.submitRefund(
        paidOrder.getOrderId(),
        amountFen,
        request.getIdempotencyKey(),
        Instant.now());
    auditLogger.recordRefundCreated(
        created.getRefundId(), request.getOperatorId(), amountFen);
    return new RefundResponse(created.getRefundId(), created.getStatus(), BigDecimal.valueOf(amountFen));
  }

}
