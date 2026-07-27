// Per-source API contract (invoices vs receipts). Endpoints + params live-verified.
const API_BASE = 'https://api-portal.invoicing.eta.gov.eg/api/v1';
export const API_ORIGIN = 'https://api-portal.invoicing.eta.gov.eg';
export const ALL_STATUSES = ['Valid', 'Invalid', 'Rejected', 'Cancelled'];

export const SOURCES = {
  invoices: {
    key: 'invoices', label: 'Invoices',
    search: API_BASE + '/documents/search', detailsBase: API_BASE + '/documents',
    resultKey: 'result',
    rowUuid: (r) => r?.source?.uuid, rowStatus: (r) => r?.source?.documentStatusEN, rowSearch: (r) => r?.source || r,
    detailUnwrap: (j) => j,
    cap: 10000, pageSize: 100, pageParam: 'Page', dirParam: 'Direction', dirOmit: 'all',
    dirs: [['Sent', 'Sent (issued)'], ['Received', 'Received'], ['all', 'All']],
    dateFields: [['Issue', 'Issuance date'], ['Submission', 'Submission date']], granular: ['Submission'],
    dateName: (f, b) => `${f}Date${b}`, extra: {}, statusServer: true, subSplit: true, filePrefix: 'eInvoices',
  },
  receipts: {
    key: 'receipts', label: 'Receipts',
    search: API_BASE + '/receipts/search', detailsBase: API_BASE + '/receipts',
    resultKey: 'receipts',
    rowUuid: (r) => r?.uuid, rowStatus: (r) => r?.status, rowSearch: (r) => r,
    detailUnwrap: (j) => j?.receipt || j,
    cap: 3000, pageSize: 50, pageParam: 'PageNo', dirParam: 'Direction', dirOmit: null,
    dirs: [['Submitted', 'Submitted (issued)'], ['All', 'All']],
    dateFields: [['DateTimeReceived', 'Received date'], ['DateTimeIssued', 'Issued date']], granular: ['DateTimeReceived'],
    dateName: (f, b) => `${f}${b}`,
    extra: { FreeText: '', LateSubmissionRequestNumber: '', PosSerialNumber: '', SortBy: 'DateTimeReceived' },
    statusServer: false, subSplit: false, filePrefix: 'eReceipts',
  },
};
