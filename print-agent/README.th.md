# KO Print Agent - คู่มือติดตั้งสำหรับร้านค้า

โปรแกรมนี้ทำงานอยู่เบื้องหลังบนคอมพิวเตอร์ที่ร้าน คอยถามข้อมูลจาก Odoo ว่ามีงานพิมพ์
ใหม่หรือไม่ แล้วส่งไปพิมพ์ที่เครื่องพิมพ์ใบเสร็จ (EASY PRINT ES-8803WA หรือรุ่นใกล้เคียง)
ผ่านเครือข่าย WiFi/LAN ของร้าน

> ก่อนทำตามคู่มือนี้ ให้ทดสอบเครื่องพิมพ์ก่อนตามคู่มือ `phase0/README.th.md`
> (หา IP, ทดสอบเชื่อมต่อ, พิมพ์ทดสอบ) ให้ผ่านก่อน จึงค่อยติดตั้งโปรแกรมตัวเต็มนี้

---

## สิ่งที่ต้องมี

- คอมพิวเตอร์ Windows ที่ร้าน ซึ่งเปิดทิ้งไว้ตลอดเวลาขายของ
- เครื่องพิมพ์ที่ทดสอบผ่าน Phase 0 แล้ว (รู้ IP ที่แน่นอน แนะนำให้ตั้งเป็น Static IP /
  DHCP Reservation ที่เราเตอร์)
- Token จากหน้า Odoo: **Point of Sale > Configuration > Print Agents**

---

## ขั้นตอนติดตั้ง

### 1. ติดตั้งโปรแกรม

มี 2 ทางเลือก:

- **ทางที่ง่ายที่สุด**: ใช้ไฟล์ `dist\ko_print_agent.exe` ที่ build มาให้แล้ว (ไม่ต้องลง
  Python) — คัดลอกทั้งโฟลเดอร์ `dist` ไปไว้ในเครื่องร้าน เช่น `C:\KO\print-agent\`
- **ถ้าต้องการรันจาก source**: ติดตั้ง [Python 3.11 ขึ้นไป](https://python.org)
  (ติ๊ก "Add python.exe to PATH" ตอนติดตั้ง) แล้วรัน:
  ```
  pip install -r requirements.txt
  ```

### 2. ตั้งค่าไฟล์ ini

1. คัดลอกไฟล์ `ko_print_agent.example.ini` เป็น `ko_print_agent.ini`
   (อยู่โฟลเดอร์เดียวกับ `ko_print_agent.exe` หรือ `ko_print_agent.py`)
2. เปิดไฟล์ด้วย Notepad แก้ 2 บรรทัดนี้:
   ```ini
   [odoo]
   url = https://kodoo.viakuma.com
   token = <คัดลอกจาก Odoo > Point of Sale > Configuration > Print Agents>
   ```
3. บันทึกไฟล์

### 3. ทดสอบก่อนติดตั้งถาวร

เปิด Command Prompt หรือ PowerShell ในโฟลเดอร์ที่มี `ko_print_agent.exe`:

```
.\ko_print_agent.exe --ping
```

ต้องเห็นข้อความ `[OK] Ping succeeded` — ถ้าขึ้น `token ผิด` หรือ error อื่น ให้ตรวจสอบ
ไฟล์ ini อีกครั้ง (ดูตาราง "ปัญหาที่พบบ่อย" ด้านล่าง)

จากนั้นทดสอบพิมพ์จริงไปที่เครื่องพิมพ์ (แทน IP ด้วยของจริง):

```
.\ko_print_agent.exe --test-print 192.168.1.50
```

ถ้ากระดาษพิมพ์ออกมาเป็นกรอบสี่เหลี่ยมพร้อมข้อความ "KO PRINT AGENT OK" และตัดกระดาษ
แสดงว่าใช้งานได้แล้ว พร้อมติดตั้งให้รันอัตโนมัติ

### 4. ติดตั้งให้รันอัตโนมัติตลอดเวลา

เปิด PowerShell แบบ **Run as Administrator** (คลิกขวาที่ไอคอน PowerShell เลือก
"Run as administrator") แล้วไปที่โฟลเดอร์ `print-agent`

หากเป็นครั้งแรกที่รันสคริปต์ PowerShell บนเครื่องนี้ อาจต้องอนุญาตก่อน (เช่นเดียวกับ
ขั้นตอนทดสอบเครื่องพิมพ์ใน `phase0/README.th.md`) ด้วยคำสั่ง:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

(คำสั่งนี้อนุญาตเฉพาะหน้าต่าง PowerShell ที่เปิดอยู่ตอนนี้ ไม่กระทบเครื่องถาวร
ต้องรันใหม่ทุกครั้งที่เปิดหน้าต่าง PowerShell ใหม่ ก่อนรันสคริปต์ .ps1)

จากนั้นรัน:

```powershell
.\build\install_service.ps1
```

โปรแกรมจะถูกตั้งให้:

- เริ่มทำงานอัตโนมัติทุกครั้งที่เปิดเครื่องคอมพิวเตอร์ (ไม่ต้อง login ก็ทำงานได้ - แต่ดู
  หมายเหตุเรื่อง "ต้อง login ครั้งแรก" ในตารางปัญหาที่พบบ่อยด้านล่าง)
- รีสตาร์ทให้เองอัตโนมัติถ้าโปรแกรมค้างหรือปิดตัวโดยไม่ได้ตั้งใจ
- จำกัดสิทธิ์การอ่านไฟล์ `ko_print_agent.ini` ให้เฉพาะผู้ใช้คนนี้และผู้ดูแลระบบ
  (Administrators) เท่านั้น เพื่อไม่ให้บัญชี Windows อื่นในเครื่องเดียวกันอ่าน token ได้

ถ้าต้องการยกเลิก (ถอนการติดตั้ง) ให้เปิด PowerShell แบบ Administrator อีกครั้ง, รัน
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` แล้วรัน:

```powershell
.\build\uninstall_service.ps1
```

---

## ไฟล์ log อยู่ที่ไหน

ไฟล์ log ชื่อ `ko_print_agent.log` อยู่ในโฟลเดอร์เดียวกับ `ko_print_agent.exe`
(ตามที่ตั้งไว้ในไฟล์ ini หัวข้อ `log_file`) เปิดดูด้วย Notepad ได้เลย ไฟล์จะไม่โตไม่สิ้นสุด
(จำกัดไว้ที่ประมาณ 5 MB โดยหมุนไฟล์เก่าอัตโนมัติ)

---

## ปัญหาที่พบบ่อย

| ปัญหา | สาเหตุ | วิธีแก้ |
|---|---|---|
| ขึ้น "token ผิด" | Token ในไฟล์ ini ไม่ตรงกับ Odoo | เข้า Odoo > Point of Sale > Configuration > Print Agents คัดลอก token ใหม่มาใส่ในไฟล์ ini แล้วรีสตาร์ทโปรแกรม (หรือรีสตาร์ท task) |
| พิมพ์ไม่ออก / เครื่องพิมพ์หาไม่เจอ | IP ของเครื่องพิมพ์เปลี่ยนไป | ตรวจสอบ IP ใหม่ (พิมพ์ Self-Test ที่เครื่องพิมพ์) แล้วแจ้งทีมงานเพื่ออัปเดตใน Odoo ถ้าตั้ง DHCP Reservation ไว้ปัญหานี้จะไม่ค่อยเกิด |
| คอมพิวเตอร์หลับ (sleep) แล้วโปรแกรมหยุดทำงาน | Windows ตั้งค่าประหยัดพลังงานให้เครื่อง sleep | ปิดการ Sleep: Settings > System > Power & sleep > ตั้ง "Screen and sleep" เป็น "Never" (อย่างน้อยตอนเปิดร้าน) |
| กังวลเรื่อง Windows Firewall | โปรแกรมนี้ "ส่งออก" (outbound) ไปหา Odoo และเครื่องพิมพ์เท่านั้น ไม่ได้เปิดรับการเชื่อมต่อเข้ามา | ปกติ Windows Firewall ไม่บล็อกการเชื่อมต่อขาออก ไม่ต้องตั้งค่าเพิ่ม |
| เปลี่ยน token ใน Odoo ใหม่ | Token เก่าถูกยกเลิก/สร้างใหม่ | แก้ไฟล์ `ko_print_agent.ini` ใส่ token ใหม่ แล้วสั่ง `Start-ScheduledTask -TaskName 'KO Print Agent'` ใหม่ (หรือรีสตาร์ทเครื่อง) |
| ต้องการทดสอบพิมพ์อีกครั้งโดยไม่ผ่าน Odoo | - | รัน `.\ko_print_agent.exe --test-print <ip-เครื่องพิมพ์>` ได้ทุกเมื่อ |
| รัน `.\build\install_service.ps1` หรือ `.\build\uninstall_service.ps1` แล้วขึ้น error ว่า "scripts is disabled on this system" / "cannot be loaded because running scripts is disabled" | Windows ปิดการรันสคริปต์ PowerShell ไว้โดยค่าเริ่มต้น (เพื่อความปลอดภัย) | รันคำสั่ง `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` ในหน้าต่าง PowerShell เดิมก่อน แล้วค่อยรันสคริปต์อีกครั้ง (ต้องทำทุกครั้งที่เปิดหน้าต่างใหม่) |
| ติดตั้ง task แล้ว แต่โปรแกรมไม่ยอมเริ่มทำงานตอนเปิดเครื่อง (โดยเฉพาะเครื่อง/บัญชีที่เพิ่งตั้งใหม่) | Task ใช้ระบบ S4U logon ซึ่งต้องการให้บัญชี Windows นี้เคย login แบบปกติ (พิมพ์รหัสผ่านเข้าหน้าจอ) มาก่อนอย่างน้อย 1 ครั้ง | Login เข้า Windows ด้วยบัญชีนี้แบบปกติสักครั้งหนึ่ง จากนั้นสั่ง `Start-ScheduledTask -TaskName 'KO Print Agent'` หรือรีสตาร์ทเครื่องอีกครั้ง |

---

## สำหรับผู้ดูแลระบบ / นักพัฒนา

ดูรายละเอียดเชิงเทคนิคเพิ่มเติม (โครงสร้างไฟล์, การ build, การทดสอบ) ได้ที่ไฟล์
`ko_print_agent.py` (มี docstring อธิบายพฤติกรรมทั้งหมด) และโฟลเดอร์ `tools/`
(`fake_printer.py`, `mock_odoo.py`) สำหรับทดสอบระบบทั้งหมดโดยไม่ต้องมี Odoo หรือ
เครื่องพิมพ์จริง
