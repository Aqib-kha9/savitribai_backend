-- ---------------------------------------------------------------------------
-- 004_purge_demo_customers.sql
--
-- The demo seeder no longer creates sample customers (they made it impossible
-- to follow docs/testing-sequence.md cleanly: an operator could not create the
-- first customer without colliding with pre-seeded rows). This migration
-- removes the six demo customers that older seed runs may have created, plus
-- any dependent rows, so an existing database matches the new seed contract.
--
-- The six demo customers are uniquely identifiable by their demo-only mobile
-- numbers (+91-90000-00001 … +91-90000-00006). No real customer can share
-- these numbers, so the purge is safe to run on every environment.
--
-- Mixed ON DELETE CASCADE coverage on the child tables means the deletes must
-- run leaf-first, in the explicit order below.
-- ---------------------------------------------------------------------------

-- Grandchildren of collections (reference collection_entry).
DELETE FROM collection_receipt
 WHERE collection_id IN (SELECT id FROM collection_entry
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM collection_review
 WHERE collection_id IN (SELECT id FROM collection_entry
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM collection_reversal
 WHERE original_collection_id IN (SELECT id FROM collection_entry
                                   WHERE customer_id IN (SELECT id FROM customer
                                                          WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')))
    OR replacement_collection_id IN (SELECT id FROM collection_entry
                                      WHERE customer_id IN (SELECT id FROM customer
                                                             WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM short_payment_allocation
 WHERE collection_id IN (SELECT id FROM collection_entry
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Grandchildren of savings accounts.
DELETE FROM interest_posting
 WHERE savings_account_id IN (SELECT id FROM savings_account
                               WHERE customer_id IN (SELECT id FROM customer
                                                      WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Grandchildren of RD accounts.
DELETE FROM rd_waiver
 WHERE rd_account_id IN (SELECT id FROM rd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM rd_penalty
 WHERE rd_account_id IN (SELECT id FROM rd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM rd_instalment
 WHERE rd_account_id IN (SELECT id FROM rd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM rd_schedule_change
 WHERE rd_account_id IN (SELECT id FROM rd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM rd_interest_posting
 WHERE rd_account_id IN (SELECT id FROM rd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Grandchildren of FD accounts.
DELETE FROM fd_interest_payout
 WHERE fd_account_id IN (SELECT id FROM fd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM fd_lien
 WHERE fd_account_id IN (SELECT id FROM fd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM fd_maturity_event
 WHERE fd_account_id IN (SELECT id FROM fd_account
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Grandchildren of loans (guarantor rows also match when the demo customer is
-- only a guarantor, not the borrower).
DELETE FROM loan_guarantor
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')))
    OR guarantor_customer_id IN (SELECT id FROM customer
                                  WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM loan_instalment
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM loan_collateral
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM loan_surplus
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM loan_restructure
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));
DELETE FROM loan_writeoff
 WHERE loan_id IN (SELECT id FROM loan
                    WHERE customer_id IN (SELECT id FROM customer
                                           WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Grandchildren of withdrawal requests.
DELETE FROM withdrawal_event
 WHERE withdrawal_id IN (SELECT id FROM withdrawal_request
                          WHERE customer_id IN (SELECT id FROM customer
                                                 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Account adjustments must go before the ledger rows they point at.
DELETE FROM account_adjustment
 WHERE savings_account_id IN (SELECT id FROM savings_account
                               WHERE customer_id IN (SELECT id FROM customer
                                                      WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')))
    OR original_transaction_id IN (SELECT t.id FROM account_transaction t
                                    JOIN savings_account s ON s.id = t.savings_account_id
                                    JOIN customer c ON c.id = s.customer_id
                                   WHERE c.mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'))
    OR adjustment_transaction_id IN (SELECT t.id FROM account_transaction t
                                      JOIN savings_account s ON s.id = t.savings_account_id
                                      JOIN customer c ON c.id = s.customer_id
                                     WHERE c.mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- The immutable savings ledger.
DELETE FROM account_transaction
 WHERE savings_account_id IN (SELECT id FROM savings_account
                               WHERE customer_id IN (SELECT id FROM customer
                                                      WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')))
    OR withdrawal_request_id IN (SELECT id FROM withdrawal_request
                                  WHERE customer_id IN (SELECT id FROM customer
                                                         WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006')));

-- Doorstep collections, then the visit log they reference.
DELETE FROM collection_entry
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

DELETE FROM visit_log
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Withdrawal requests (reference savings, RD and FD accounts).
DELETE FROM withdrawal_request
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- RD accounts before loans (rd_account.linked_loan_id references loan).
DELETE FROM rd_account
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Loans, then applications, then the FD accounts loans may be secured against.
DELETE FROM loan
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

DELETE FROM loan_application
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

DELETE FROM fd_account
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Savings accounts last among accounts.
DELETE FROM savings_account
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Customer-scoped operational records (no cascade on these).
DELETE FROM field_verification
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM agent_customer_assignment
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM agent_transfer_log
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM notification_outbox
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM dispute_case
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM claim
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_complaint
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_status_history
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Cascading children (kept explicit for clarity and so a future schema change
-- that drops the cascade still purges correctly).
DELETE FROM data_subject_request
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_address
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_identity_document
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_kyc
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM nominee
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));
DELETE FROM customer_consent
 WHERE customer_id IN (SELECT id FROM customer
                        WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006'));

-- Finally the demo customer rows themselves.
DELETE FROM customer
 WHERE mobile IN ('+91-90000-00001','+91-90000-00002','+91-90000-00003','+91-90000-00004','+91-90000-00005','+91-90000-00006');
