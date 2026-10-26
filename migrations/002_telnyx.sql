-- Preserve archived legacy operator IDs when importing history.
UPDATE sessions SET data=json_remove(json_set(data,'$.operator.carrierCallId',
  json_extract(data,'$.operator.twilioCallId')),'$.operator.twilioCallId')
WHERE json_type(data,'$.operator.twilioCallId') IS NOT NULL;
UPDATE call_attempts SET data=json_remove(json_set(data,'$.carrierCallId',
  json_extract(data,'$.twilioCallId')),'$.twilioCallId')
WHERE role='operator' AND json_type(data,'$.twilioCallId') IS NOT NULL;
