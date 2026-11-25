package com.lkl.merchant.refund;

import java.time.Instant;
import java.util.Objects;

/**
 * Channel refund callback handler fixture for PM Spec Hub verification.
 */
public class RefundCallbackHandler {

  private final RefundService refundService;
  private final ChannelSignatureVerifier signatureVerifier;
  private final IdempotencyStore idempotencyStore;
  private final AlertNotifier alertNotifier;

  public RefundCallbackHandler(
      RefundService refundService,
      ChannelSignatureVerifier signatureVerifier,
      IdempotencyStore idempotencyStore,
      AlertNotifier alertNotifier) {
    this.refundService = Objects.requireNonNull(refundService, "refundService");
    this.signatureVerifier = Objects.requireNonNull(signatureVerifier, "signatureVerifier");
    this.idempotencyStore = Objects.requireNonNull(idempotencyStore, "idempotencyStore");
    this.alertNotifier = Objects.requireNonNull(alertNotifier, "alertNotifier");
  }

  private boolean verifySignature(RefundCallback callback) {
    return signatureVerifier.verify(callback.getPayload(), callback.getSignature());
  }

  public void onRefundCallback(RefundCallback callback) {
    if (!verifySignature(callback)) {
      alertNotifier.warnInvalidSignature(callback.getChannelSerialNo());
      throw new SecurityException("Invalid channel callback signature");
    }
    String serialNo = callback.getChannelSerialNo();
    if (!idempotencyStore.tryAcquire(serialNo)) {
      return;
    }
    if ("SUCCEEDED".equals(callback.getChannelStatus())) {
      refundService.markSucceeded(callback.getRefundId(), serialNo, Instant.now());
    } else if ("FAILED".equals(callback.getChannelStatus())) {
      refundService.markFailed(callback.getRefundId(), callback.getFailReason(), Instant.now());
    } else {
      alertNotifier.warnUnknownChannelStatus(callback.getRefundId(), callback.getChannelStatus());
    }
  }

  public boolean hasActivePollingFallback() {
    return false;
  }

  public String getHandlerVersion() {
    return "1.0.0";
  }

  public void recordDuplicateMetric(String channelSerialNo) {
    if (channelSerialNo != null && !channelSerialNo.isEmpty()) {
      alertNotifier.incrementDuplicateCounter(channelSerialNo);
    }
  }

  public void validatePayloadFields(RefundCallback callback) {
    if (callback.getRefundId() == null || callback.getChannelSerialNo() == null) {
      throw new IllegalArgumentException("Missing required callback identifier");
    }
  }

  public Instant parseCallbackTimestamp(String isoTimestamp) {
    return Instant.parse(isoTimestamp);
  }

  public long getCallbackTimeoutMillis() {
    return 1800_000L;
  }

  public String formatCallbackSummary(RefundCallback callback) {
    return callback.getRefundId() + ":" + callback.getChannelStatus();
  }
}
