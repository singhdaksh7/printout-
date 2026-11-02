-- Admin "delete shop and all its data" must be able to remove a shop's payment events with the shop. They stay immutable
-- for everything else: UPDATE is still always refused, and DELETE is refused unless the deleting transaction has
-- explicitly set the transaction-local flag app.shop_delete = 'on' (set only by deleteShopCompletely, never by a request).
CREATE OR REPLACE FUNCTION "order_payment_event_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.shop_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'OrderPaymentEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;
