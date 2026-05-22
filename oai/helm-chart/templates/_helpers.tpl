{{- define "oai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "oai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "oai.labels" -}}
app.kubernetes.io/name: {{ include "oai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "oai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "oai.postgresHost" -}}
{{- printf "%s-postgres" (include "oai.fullname" .) }}
{{- end }}

{{- define "oai.garageSvcName" -}}
{{- printf "%s-garage" (include "oai.fullname" .) }}
{{- end }}

{{- define "oai.serviceAccountName" -}}
{{- if .Values.serviceAccount.name }}
{{- .Values.serviceAccount.name }}
{{- else }}
{{- include "oai.fullname" . }}
{{- end }}
{{- end }}
