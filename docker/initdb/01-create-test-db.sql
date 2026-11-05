-- Separate database for the test suite. Tests refuse to run against any
-- database whose name does not end in "_test" (see test/helpers/db.ts).
CREATE DATABASE orders_test OWNER orders;
