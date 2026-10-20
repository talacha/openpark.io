{{- define "openpark.image" -}}
{{ .root.Values.image.registry }}/{{ .name }}:{{ .root.Values.image.tag | default .root.Chart.AppVersion }}
{{- end -}}

{{- define "openpark.dbSecret" -}}{{ .Values.database.existingSecret | default (printf "%s-db" .Release.Name) }}{{- end -}}
{{- define "openpark.authSecret" -}}{{ .Values.auth.existingSecret | default (printf "%s-auth" .Release.Name) }}{{- end -}}

{{- define "openpark.apiEnv" -}}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "openpark.dbSecret" . }}, key: DATABASE_URL } }
- name: ADMIN_DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "openpark.dbSecret" . }}, key: ADMIN_DATABASE_URL } }
- name: JWT_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "openpark.authSecret" . }}, key: JWT_SECRET } }
- name: STORAGE_DIR
  value: /data
{{- if .Values.database.appPassword }}
- name: OPENPARK_APP_PASSWORD
  value: {{ .Values.database.appPassword | quote }}
{{- end }}
{{- if .Values.ai.enabled }}
- name: ALPR_URL
  value: http://{{ .Release.Name }}-alpr:8000
{{- end }}
{{- end -}}
