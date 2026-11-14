-- 081: recover the picture of catalog items the AI already sent on WhatsApp.
-- Until this fix, engineSendMedia sent the image/file to the customer but
-- saved the message without media_url, so the inbox showed "unavailable".
-- Each such message is matched to its catalog item (ai_attachments) by name:
--   * product cards carry the name in metadata->>'name',
--   * other attachments have the caption "*<name>*".
-- Only rows still missing media_url are touched. Idempotent.

UPDATE messages m
   SET media_url = a.media_url
  FROM conversations c, ai_attachments a
 WHERE m.conversation_id = c.id
   AND a.account_id = c.account_id
   AND m.media_url IS NULL
   AND m.sender_type = 'bot'
   AND m.content_type IN ('image', 'video', 'document')
   AND a.media_url IS NOT NULL
   AND (
        (m.metadata->>'kind' = 'product_card' AND m.metadata->>'name' = a.name)
     OR m.content_text = '*' || a.name || '*'
   );
