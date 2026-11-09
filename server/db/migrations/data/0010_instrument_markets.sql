-- Instruments get a market (exchange) chosen from a list. The market decides the symbol sent to price
-- providers (e.g. SHOP on the TSX is priced as SHOP.TRT by Alpha Vantage). The free-text exchange column now
-- holds the market id, and earlier ".TO" / ".V" symbols (which Alpha Vantage doesn't recognise) are corrected.

ALTER TABLE instruments ADD COLUMN market TEXT NOT NULL DEFAULT 'US'
  CHECK (market IN ('US','TSX','TSXV','LSE','XETRA','BSE','SSE','SZSE','CRYPTO','METAL','OTHER'));

UPDATE instruments SET market = CASE
  WHEN price_source = 'manual' THEN 'OTHER'
  WHEN kind = 'crypto' THEN 'CRYPTO'
  WHEN kind = 'metal' THEN 'METAL'
  WHEN upper(exchange) IN ('TSXV','TSX-V','TSX V','CVE','V','TRV','VENTURE') OR provider_symbol LIKE '%.V'
    OR provider_symbol LIKE '%.TRV' OR provider_symbol LIKE '%.VN' THEN 'TSXV'
  WHEN upper(exchange) IN ('TSX','TSE','TOR','TO','TRT','TORONTO') OR provider_symbol LIKE '%.TO'
    OR provider_symbol LIKE '%.TRT' THEN 'TSX'
  WHEN upper(exchange) IN ('LSE','LON','L','LONDON') OR provider_symbol LIKE '%.LON' OR provider_symbol LIKE '%.L' THEN 'LSE'
  WHEN upper(exchange) IN ('XETRA','DEX','ETR','DE','GER') OR provider_symbol LIKE '%.DEX' OR provider_symbol LIKE '%.DE' THEN 'XETRA'
  WHEN upper(exchange) IN ('BSE','BOM') OR provider_symbol LIKE '%.BSE' OR provider_symbol LIKE '%.BO' THEN 'BSE'
  WHEN upper(exchange) IN ('SSE','SHH','SS','SHANGHAI') OR provider_symbol LIKE '%.SHH' OR provider_symbol LIKE '%.SS' THEN 'SSE'
  WHEN upper(exchange) IN ('SZSE','SHZ','SZ','SHENZHEN') OR provider_symbol LIKE '%.SHZ' OR provider_symbol LIKE '%.SZ' THEN 'SZSE'
  ELSE 'US'
END;

-- Symbols: keep the bare ticker in `symbol`, and the provider form in `provider_symbol`.
UPDATE instruments SET symbol = substr(symbol, 1, length(symbol) - 3) WHERE market = 'TSX' AND symbol LIKE '%.TO';
UPDATE instruments SET symbol = substr(symbol, 1, length(symbol) - 2) WHERE market = 'TSXV' AND symbol LIKE '%.V';
UPDATE instruments SET provider_symbol = CASE market
    WHEN 'TSX' THEN replace(replace(provider_symbol, '.TRT', ''), '.TO', '') || '.TRT'
    WHEN 'TSXV' THEN replace(replace(provider_symbol, '.TRV', ''), '.V', '') || '.TRV'
    ELSE provider_symbol END
WHERE market IN ('TSX','TSXV');

-- The exchange column now mirrors the market (it is part of the symbol + exchange uniqueness rule).
UPDATE instruments SET exchange = market;
