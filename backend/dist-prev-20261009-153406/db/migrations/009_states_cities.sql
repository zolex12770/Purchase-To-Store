-- Supplier State -> City dependent dropdown, backed by real master data —
-- reuses `lookups` (already supports a parent/child hierarchy via parent_id,
-- the same mechanism MAIN_GROUP/SUB_MAIN_GROUP already use) rather than a
-- new, duplicate table pair. STATE and CITY are geographic reference data —
-- classified `is_system` (like UOM/CURRENCY already are), so they are never
-- candidates for db:purify and never company-specific data.
ALTER TABLE lookups DROP CONSTRAINT chk_lookups_category;
ALTER TABLE lookups ADD CONSTRAINT chk_lookups_category CHECK (category IN (
  'DEPARTMENT', 'COST_CENTRE', 'ITEM_TYPE', 'MAIN_GROUP', 'SUB_MAIN_GROUP',
  'UOM', 'INDENT_TYPE', 'PO_TYPE', 'CURRENCY', 'PAYMENT_TERMS', 'STATE', 'CITY'
));

INSERT INTO lookups (category, code, name, sort_order, is_system) VALUES
  ('STATE','AP','Andhra Pradesh',1,true),
  ('STATE','AR','Arunachal Pradesh',2,true),
  ('STATE','AS','Assam',3,true),
  ('STATE','BR','Bihar',4,true),
  ('STATE','CT','Chhattisgarh',5,true),
  ('STATE','GA','Goa',6,true),
  ('STATE','GJ','Gujarat',7,true),
  ('STATE','HR','Haryana',8,true),
  ('STATE','HP','Himachal Pradesh',9,true),
  ('STATE','JH','Jharkhand',10,true),
  ('STATE','KA','Karnataka',11,true),
  ('STATE','KL','Kerala',12,true),
  ('STATE','MP','Madhya Pradesh',13,true),
  ('STATE','MH','Maharashtra',14,true),
  ('STATE','MN','Manipur',15,true),
  ('STATE','ML','Meghalaya',16,true),
  ('STATE','MZ','Mizoram',17,true),
  ('STATE','NL','Nagaland',18,true),
  ('STATE','OD','Odisha',19,true),
  ('STATE','PB','Punjab',20,true),
  ('STATE','RJ','Rajasthan',21,true),
  ('STATE','SK','Sikkim',22,true),
  ('STATE','TN','Tamil Nadu',23,true),
  ('STATE','TG','Telangana',24,true),
  ('STATE','TR','Tripura',25,true),
  ('STATE','UP','Uttar Pradesh',26,true),
  ('STATE','UT','Uttarakhand',27,true),
  ('STATE','WB','West Bengal',28,true),
  ('STATE','AN','Andaman and Nicobar Islands',29,true),
  ('STATE','CH','Chandigarh',30,true),
  ('STATE','DN','Dadra and Nagar Haveli and Daman and Diu',31,true),
  ('STATE','DL','Delhi',32,true),
  ('STATE','JK','Jammu and Kashmir',33,true),
  ('STATE','LA','Ladakh',34,true),
  ('STATE','LD','Lakshadweep',35,true),
  ('STATE','PY','Puducherry',36,true);

INSERT INTO lookups (category, code, name, parent_id, sort_order, is_system)
SELECT 'CITY', v.state_code || '-' || upper(regexp_replace(v.city, '[^A-Za-z0-9]+', '', 'g')), v.city, s.id, v.rn, true
FROM (
  VALUES
  -- Andhra Pradesh
  ('AP','Visakhapatnam',1),('AP','Vijayawada',2),('AP','Guntur',3),('AP','Nellore',4),('AP','Kurnool',5),
  ('AP','Kadapa',6),('AP','Rajahmundry',7),('AP','Tirupati',8),('AP','Anantapur',9),('AP','Kakinada',10),
  ('AP','Eluru',11),('AP','Chittoor',12),('AP','Ongole',13),('AP','Srikakulam',14),('AP','Vizianagaram',15),
  -- Arunachal Pradesh
  ('AR','Itanagar',1),('AR','Naharlagun',2),('AR','Pasighat',3),('AR','Tawang',4),('AR','Ziro',5),
  -- Assam
  ('AS','Guwahati',1),('AS','Silchar',2),('AS','Dibrugarh',3),('AS','Jorhat',4),('AS','Nagaon',5),
  ('AS','Tinsukia',6),('AS','Tezpur',7),('AS','Bongaigaon',8),('AS','Karimganj',9),('AS','Sivasagar',10),
  -- Bihar
  ('BR','Patna',1),('BR','Gaya',2),('BR','Bhagalpur',3),('BR','Muzaffarpur',4),('BR','Darbhanga',5),
  ('BR','Purnia',6),('BR','Ara',7),('BR','Begusarai',8),('BR','Katihar',9),('BR','Munger',10),
  ('BR','Chapra',11),('BR','Bihar Sharif',12),('BR','Sasaram',13),
  -- Chhattisgarh
  ('CT','Raipur',1),('CT','Bhilai',2),('CT','Bilaspur',3),('CT','Korba',4),('CT','Durg',5),
  ('CT','Rajnandgaon',6),('CT','Jagdalpur',7),('CT','Raigarh',8),('CT','Ambikapur',9),
  -- Goa
  ('GA','Panaji',1),('GA','Margao',2),('GA','Vasco da Gama',3),('GA','Mapusa',4),('GA','Ponda',5),
  -- Gujarat
  ('GJ','Ahmedabad',1),('GJ','Surat',2),('GJ','Vadodara',3),('GJ','Rajkot',4),('GJ','Bhavnagar',5),
  ('GJ','Jamnagar',6),('GJ','Gandhinagar',7),('GJ','Junagadh',8),('GJ','Anand',9),('GJ','Nadiad',10),
  ('GJ','Morbi',11),('GJ','Mehsana',12),('GJ','Bharuch',13),('GJ','Vapi',14),('GJ','Navsari',15),
  ('GJ','Valsad',16),('GJ','Porbandar',17),('GJ','Palanpur',18),
  -- Haryana
  ('HR','Faridabad',1),('HR','Gurugram',2),('HR','Panipat',3),('HR','Ambala',4),('HR','Hisar',5),
  ('HR','Rohtak',6),('HR','Karnal',7),('HR','Sonipat',8),('HR','Yamunanagar',9),('HR','Panchkula',10),
  ('HR','Bhiwani',11),('HR','Sirsa',12),
  -- Himachal Pradesh
  ('HP','Shimla',1),('HP','Dharamshala',2),('HP','Solan',3),('HP','Mandi',4),('HP','Kullu',5),
  ('HP','Una',6),('HP','Bilaspur (HP)',7),
  -- Jharkhand
  ('JH','Ranchi',1),('JH','Jamshedpur',2),('JH','Dhanbad',3),('JH','Bokaro',4),('JH','Deoghar',5),
  ('JH','Hazaribagh',6),('JH','Giridih',7),
  -- Karnataka
  ('KA','Bengaluru',1),('KA','Mysuru',2),('KA','Hubballi',3),('KA','Mangaluru',4),('KA','Belagavi',5),
  ('KA','Kalaburagi',6),('KA','Davanagere',7),('KA','Ballari',8),('KA','Shivamogga',9),('KA','Tumakuru',10),
  ('KA','Udupi',11),('KA','Hassan',12),('KA','Bidar',13),('KA','Raichur',14),
  -- Kerala
  ('KL','Thiruvananthapuram',1),('KL','Kochi',2),('KL','Kozhikode',3),('KL','Thrissur',4),('KL','Kollam',5),
  ('KL','Kannur',6),('KL','Alappuzha',7),('KL','Palakkad',8),('KL','Kottayam',9),('KL','Malappuram',10),
  -- Madhya Pradesh
  ('MP','Bhopal',1),('MP','Indore',2),('MP','Jabalpur',3),('MP','Gwalior',4),('MP','Ujjain',5),
  ('MP','Sagar',6),('MP','Dewas',7),('MP','Satna',8),('MP','Ratlam',9),('MP','Rewa',10),
  ('MP','Katni',11),('MP','Singrauli',12),
  -- Maharashtra
  ('MH','Mumbai',1),('MH','Pune',2),('MH','Nagpur',3),('MH','Nashik',4),('MH','Thane',5),
  ('MH','Aurangabad',6),('MH','Solapur',7),('MH','Kolhapur',8),('MH','Amravati',9),('MH','Navi Mumbai',10),
  ('MH','Sangli',11),('MH','Akola',12),('MH','Jalgaon',13),('MH','Latur',14),('MH','Ahmednagar',15),
  ('MH','Palghar',16),('MH','Vasai-Virar',17),('MH','Nanded',18),('MH','Satara',19),('MH','Chandrapur',20),
  -- Manipur
  ('MN','Imphal',1),('MN','Thoubal',2),('MN','Churachandpur',3),
  -- Meghalaya
  ('ML','Shillong',1),('ML','Tura',2),('ML','Jowai',3),
  -- Mizoram
  ('MZ','Aizawl',1),('MZ','Lunglei',2),
  -- Nagaland
  ('NL','Kohima',1),('NL','Dimapur',2),('NL','Mokokchung',3),
  -- Odisha
  ('OD','Bhubaneswar',1),('OD','Cuttack',2),('OD','Rourkela',3),('OD','Berhampur',4),('OD','Sambalpur',5),
  ('OD','Puri',6),('OD','Balasore',7),
  -- Punjab
  ('PB','Ludhiana',1),('PB','Amritsar',2),('PB','Jalandhar',3),('PB','Patiala',4),('PB','Bathinda',5),
  ('PB','Mohali',6),('PB','Hoshiarpur',7),('PB','Pathankot',8),('PB','Moga',9),
  -- Rajasthan
  ('RJ','Jaipur',1),('RJ','Jodhpur',2),('RJ','Udaipur',3),('RJ','Kota',4),('RJ','Ajmer',5),
  ('RJ','Bikaner',6),('RJ','Alwar',7),('RJ','Bhilwara',8),('RJ','Sikar',9),('RJ','Bharatpur',10),
  ('RJ','Pali',11),
  -- Sikkim
  ('SK','Gangtok',1),('SK','Namchi',2),
  -- Tamil Nadu
  ('TN','Chennai',1),('TN','Coimbatore',2),('TN','Madurai',3),('TN','Tiruchirappalli',4),('TN','Salem',5),
  ('TN','Tirunelveli',6),('TN','Erode',7),('TN','Vellore',8),('TN','Thoothukudi',9),('TN','Dindigul',10),
  ('TN','Thanjavur',11),('TN','Hosur',12),
  -- Telangana
  ('TG','Hyderabad',1),('TG','Warangal',2),('TG','Nizamabad',3),('TG','Karimnagar',4),('TG','Khammam',5),
  ('TG','Ramagundam',6),('TG','Secunderabad',7),
  -- Tripura
  ('TR','Agartala',1),('TR','Udaipur (TR)',2),
  -- Uttar Pradesh
  ('UP','Lucknow',1),('UP','Kanpur',2),('UP','Ghaziabad',3),('UP','Agra',4),('UP','Varanasi',5),
  ('UP','Meerut',6),('UP','Prayagraj',7),('UP','Noida',8),('UP','Bareilly',9),('UP','Aligarh',10),
  ('UP','Moradabad',11),('UP','Saharanpur',12),('UP','Gorakhpur',13),('UP','Jhansi',14),('UP','Muzaffarnagar',15),
  ('UP','Mathura',16),('UP','Firozabad',17),('UP','Rampur',18),('UP','Shahjahanpur',19),
  -- Uttarakhand
  ('UT','Dehradun',1),('UT','Haridwar',2),('UT','Roorkee',3),('UT','Haldwani',4),('UT','Rudrapur',5),
  ('UT','Nainital',6),
  -- West Bengal
  ('WB','Kolkata',1),('WB','Howrah',2),('WB','Durgapur',3),('WB','Asansol',4),('WB','Siliguri',5),
  ('WB','Bardhaman',6),('WB','Malda',7),('WB','Kharagpur',8),('WB','Haldia',9),
  -- Union Territories
  ('AN','Port Blair',1),
  ('CH','Chandigarh City',1),
  ('DN','Daman',1),('DN','Silvassa',2),
  ('DL','New Delhi',1),('DL','Dwarka',2),('DL','Rohini',3),('DL','Karol Bagh',4),('DL','Saket',5),
  ('JK','Srinagar',1),('JK','Jammu',2),('JK','Anantnag',3),('JK','Baramulla',4),
  ('LA','Leh',1),('LA','Kargil',2),
  ('LD','Kavaratti',1),
  ('PY','Puducherry Town',1),('PY','Karaikal',2)
) AS v(state_code, city, rn)
JOIN lookups s ON s.category = 'STATE' AND s.code = v.state_code AND s.deleted_at IS NULL;
