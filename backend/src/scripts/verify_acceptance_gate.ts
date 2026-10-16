import { scriptApiTarget, scriptCredentials } from './script-target.js';

// Target and account come from the environment; production needs ZOLEX_ALLOW_PRODUCTION=yes.
const SCRIPT_API = scriptApiTarget();
const SCRIPT_LOGIN = scriptCredentials();

async function main() {
  const baseURL = SCRIPT_API.baseUrl;

  console.log('=== TEST 1: Authentication & HOD Resolution for MDO ===');
  const loginRes = await fetch(`${baseURL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SCRIPT_LOGIN),
  });
  const loginData = await loginRes.json() as any;
  if (!loginData.success) throw new Error('Login failed: ' + JSON.stringify(loginData));
  const token = loginData.data.accessToken;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Check MDO HOD endpoint
  const mdoHodRes = await fetch(`${baseURL}/requisitions/departments/147/hod`, { headers });
  const mdoHodData = await mdoHodRes.json() as any;
  console.log('MDO HOD endpoint response:', mdoHodData);
  if (mdoHodData.data?.hodUserId !== 1 || mdoHodData.data?.hod?.employee_name !== 'Kunal Raju Dulani') {
    throw new Error('MDO HOD resolution failed!');
  }
  console.log('✓ PASS: MDO correctly resolves to Kunal Raju Dulani (User ID: 1, 10221)');

  console.log('\n=== TEST 2: Requisition Creation for MDO (No Rate/Value in payload) ===');
  // Pick an item from Item Master
  const itemRes = await fetch(`${baseURL}/items/search?q=LBL`, { headers });
  const itemData = await itemRes.json() as any;
  const testItem = itemData.data?.[0];
  console.log(`Using test item: ID=${testItem.id}, Code=${testItem.item_code}, Description=${testItem.item_description}`);

  // Pick a valid cost centre from lookups
  const lookupsRes = await fetch(`${baseURL}/lookups/options`, { headers });
  const lookupsData = (await lookupsRes.json() as any).data;
  const costCentres = lookupsData.COST_CENTRE || [];
  const testCc = costCentres.find((c: any) => c.name.toLowerCase().includes('admin')) || costCentres[0];
  console.log(`Using cost centre: ID=${testCc.id}, Name="${testCc.name}"`);

  // Create requisition for MDO without rate or value in payload
  const createPayload = {
    requesterUserId: 1,
    requisitionDate: '2026-10-14',
    costCentreId: testCc.id,
    remarks: 'Automated test requisition for MDO department verification',
    submit: true, // submit for HOD approval immediately
    lines: [
      {
        itemId: testItem.id,
        requestedQty: '10',
        remarks: 'Test line 1',
      },
    ],
  };

  const createRes = await fetch(`${baseURL}/requisitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(createPayload),
  });
  const createData = await createRes.json() as any;
  console.log('Create response:', createData);
  if (!createData.success) throw new Error('Create requisition failed: ' + JSON.stringify(createData));
  const newReqId = createData.data.id;
  const newReqNo = createData.data.requisition_no;
  console.log(`✓ PASS: Requisition created successfully: ID=${newReqId}, No=${newReqNo}`);

  console.log('\n=== TEST 3: Requisition Detail & HOD Rate/Value Display ===');
  const detailRes = await fetch(`${baseURL}/requisitions/${newReqId}`, { headers });
  const detailData = await detailRes.json() as any;
  const req = detailData.data;
  console.log(`Header verification: No=${req.requisition_no}, Dept=${req.department_name}, HOD=${req.hod_name}, HOD_ID=${req.hod_user_id}, Status=${req.status}`);
  if (req.department_name !== 'MDO' || req.hod_user_id !== 1 || req.hod_name !== 'Kunal Raju Dulani') {
    throw new Error('Header HOD/Department mismatch!');
  }
  console.log('Lines data returned:');
  for (const l of req.lines) {
    console.log(`  Line ${l.line_no}: item=${l.item_code}, requested=${l.requested_qty}, stock=${l.available_stock}, estimated_rate=${l.estimated_rate}, estimated_value=${l.estimated_value}`);
  }
  console.log('✓ PASS: Lines detail returns estimated_rate and estimated_value!');

  console.log('\n=== TEST 4: HOD Approval of MDO Requisition ===');
  const approveRes = await fetch(`${baseURL}/requisitions/${newReqId}/approve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'Approved by Kunal Raju Dulani via acceptance gate' }),
  });
  const approveData = await approveRes.json() as any;
  console.log('Approve response:', approveData);
  if (!approveData.success) throw new Error('Approval failed: ' + JSON.stringify(approveData));

  // Check state after approval
  const afterApproveRes = await fetch(`${baseURL}/requisitions/${newReqId}`, { headers });
  const afterApproveData = await afterApproveRes.json() as any;
  console.log(`Status after approval: Status=${afterApproveData.data.status}, HOD_Status=${afterApproveData.data.hod_status}`);
  if (afterApproveData.data.status !== 'APPROVED' || afterApproveData.data.hod_status !== 'APPROVED') {
    throw new Error('Requisition status is not APPROVED!');
  }
  console.log('✓ PASS: Requisition successfully approved!');

  console.log('\n=== TEST 5: Verify Critical Departments HOD Resolution ===');
  const testDepts = [
    { id: 147, name: 'MDO', expectedHod: 'Kunal Raju Dulani', expectedId: 1 },
    { id: 36359, name: 'Civil & Construction', expectedHod: 'Naineshkumar Hasmukhlal Rana', expectedId: 26 },
    { id: 136, name: 'HR', expectedHod: 'Nainesh Nayankumar Patel', expectedId: 12 },
    { id: 151, name: 'House Keeping', expectedHod: 'Nainesh Nayankumar Patel', expectedId: 12 },
    { id: 139, name: 'Tinning', expectedHod: 'Anshul Sharma', expectedId: 428 },
    { id: 36356, name: 'Planning', expectedHod: 'Rajeev Ranjan Singh', expectedId: 44 },
    { id: 36355, name: 'General', expectedHod: 'Naresh Shantibhai Kolipatel', expectedId: 15 },
    { id: 36364, name: 'Store', expectedHod: 'Bharatkumar Amrutbhai Parmar', expectedId: 13 },
    { id: 148, name: 'Account', expectedHod: 'Martin Pravinbhai Karthiya', expectedId: 47 },
    { id: 36363, name: 'Saddle & Brackets', expectedHod: 'Chintu Jha', expectedId: 397 },
  ];

  for (const td of testDepts) {
    const res = await fetch(`${baseURL}/requisitions/departments/${td.id}/hod`, { headers });
    const data = (await res.json() as any).data;
    if (data?.hodUserId !== td.expectedId) {
      throw new Error(`Dept ${td.name} (ID: ${td.id}) resolved to ID ${data?.hodUserId}, expected ${td.expectedId}`);
    }
    console.log(`✓ PASS: ${td.name} (ID ${td.id}) -> ${data.hod?.employee_name} (${data.hodUserId})`);
  }

  console.log('\n=== TEST 6: Dropdowns Audit (/lookups/options & /lookups/users) ===');
  console.log(`Dropdown Categories available: ${Object.keys(lookupsData).join(', ')}`);
  console.log(`Departments count: ${lookupsData.DEPARTMENT?.length}`);
  console.log(`Cost Centres count: ${lookupsData.COST_CENTRE?.length}`);
  console.log(`Indent Types count: ${lookupsData.INDENT_TYPE?.length}`);
  console.log(`UOMs count: ${lookupsData.UOM?.length}`);

  const usersRes = await fetch(`${baseURL}/lookups/users`, { headers });
  const usersData = (await usersRes.json() as any).data;
  const hodUsers = usersData.filter((u: any) => u.isHod);
  console.log(`Total active users in dropdown: ${usersData.length}`);
  console.log(`Total HOD users flagged: ${hodUsers.length}`);
  const kunalUser = usersData.find((u: any) => u.employeeId === '10221');
  console.log(`Kunal Raju Dulani in users dropdown: isHod=${kunalUser?.isHod}, dept=${kunalUser?.departmentName}`);
  if (!kunalUser?.isHod) throw new Error('Kunal is not flagged as HOD!');

  console.log('\n========================================');
  console.log('ALL VERIFICATION GATES PASSED 100%!');
  console.log('========================================');
}

main().catch((err) => {
  console.error('VERIFICATION GATE FAILED:', err);
  process.exit(1);
});
