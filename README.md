# دانلودر مکتب‌خونه (Maktabkhooneh Downloader)
ابزار خط فرمان برای دانلود ویدیوهای قابل‌دسترسی دوره‌های سایت [مکتب‌خونه](https://maktabkhooneh.org/) شامل ویدیوهای درس‌ها، فایلهای ضمیمه درس، زیرنویس ویدیو، به شکل همه با هم، یکجا و طبقه بندی شده. \
فقط محتوایی را می‌توانید دانلود کنید که قانوناً به آن دسترسی دارید.

![maktabkhooneh website screenshot](https://github.com/user-attachments/assets/b54f6fac-10f0-423c-9da2-236c4d8cc5d3)

## 🎬 ویدیو
https://github.com/user-attachments/assets/38ecfd3e-4281-4e20-854d-18ad5dae5691

## ✨ امکانات
- ورود و لاگین به سایت با ایمیل و پسورد و ذخیره کوکی در فایل نشست چندکاربره
- احراز هویت با کوکی از طریق متغییرهای محیطی
- تشخیص و انتخاب بهترین کیفیت ویدیوی درس مورد نظر
- پوشه خروجی ثابت: `download/<نام دوره>`
- دانلود زیرنویس ویدیوها اگر موجود باشد، با همان نام پایه ویدیو
- دانلود فایل‌های ضمیمه درس، کنار ویدیو
- نمایش خلاصه پروفایل کاربر (وضعیت لاگین، ایمیل، اشتراک، خرید دوره)
- حالت نمونه‌گیری (Sample) با دانلود تنها N بایت اول هر ویدیو برای تست سریع
- ادامه دانلود از همان‌جا (Resume) در صورت قطع شدن یا اجرای مجدد
- نوار پیشرفت دقیق: درصد + حجم دانلود شده / کل + سرعت تقریبی
- لاگ‌های رنگی و ایموجی برای خوانایی و تجربه بهتر

## ✅ پیش‌نیازها
- ‏Node.js نسخه 18 یا بالاتر
- یک حساب کاربری در maktabkhooneh.org

## 🔐 ورود (Login) و نشست چندکاربره
دو راه اصلی:

1. استفاده از ایمیل و پسورد: (ساده و پیشنهاد می‌شود)
	 ```powershell
	 node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123" 
	 ```
	 در اولین ورود، کوکی (csrftoken + sessionid) در فایل پیش‌فرض `session.json` ذخیره می‌شود و دفعات بعد بدون نیاز به پسورد استفاده می‌گردد (مگر این که منقضی شود یا `--force-login` بزنید).

> **💡 فرمت جدید آدرس دوره (LMS):** این ابزار از هر دو فرمت آدرس پشتیبانی می‌کند:
> - فرمت قدیمی: `https://maktabkhooneh.org/course/<slug>/`
> - فرمت جدید: `https://maktabkhooneh.org/lms/course/<slug>/unit/<unit_id>/`
>
> در فرمت جدید، شناسه عددی دوره از پسوند `-mk<id>` در slug استخراج می‌شود و ویدیوها از طریق API جدید (`/api/v1/lms/...`) دریافت می‌گردند. اگر آدرس یک واحد خاص (`unit/<unit_id>`) را بدهید، همچنان کل دوره دانلود می‌شود.
2. استفاده از کوکی آماده (Override):
	 اگر نمی‌خواهید پسورد را در خط فرمان بزنید، می‌توانید کوکی را به صورت دستی (مانند قبل) ست کنید تا لاگین خودکار نادیده گرفته شود.

### ساختار فایل نشست
فایل `session.json` به صورت چندکاربره است:
```jsonc
{
	"users": {
		"you@example.com": { "cookie": "csrftoken=...; sessionid=...", "updated": "2025-08-17T12:34:56.000Z" },
		"other@example.com": { "cookie": "csrftoken=...; sessionid=...", "updated": "2025-08-17T13:00:00.000Z" }
	},
	"lastUsed": "you@example.com"
}
```
در هر اجرا اگر `--user` مشخص کنید همان کاربر هدف قرار می‌گیرد، وگرنه آخرین کاربر استفاده شده بررسی می‌شود.

### اجبار ورود مجدد
اگر می‌خواهید با وجود معتبر بودن نشست، دوباره لاگین شود:
```powershell
node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123" --force-login 
```

## ⚠️ تنظیم کوکی (روش دستی قدیمی که پیشنهاد نمی‌شود!)

اگر ترجیح می‌دهید کوکی را دستی ست کنید یا لاگین مستقیم کار نکرد، مانند قبل کوکی `sessionid` (و بهتر: همراه csrftoken) را از مرورگر استخراج کنید.

بعد از اینکه به سایت maktabkhooneh.org لاگین شدید. روی صفحه راست کلیک کرده و inspect را بزنید. (یا CTRL+SHIFT+i بزنید) به تب Network بروید. صفحه را رفرش کنید. روی درخواست اول کلیک کنید. در سمت مقابل دنبال Cookie بگردید و آنجا چیزی که مهم است مقدار sessionid است و آن را کپی بگیرید.

![Get Cookies](https://github.com/user-attachments/assets/7943bed5-ffae-4075-a2ba-29f091d572b4)

دو روش برای تنظیم کوکی:
1) متغیر محیطی `MK_COOKIE`
2) یا قرار دادن مسیر فایل کوکی در `MK_COOKIE_FILE`

نکته: چون مقدار کوکی شامل کاراکترهایی مانند `;` و `=` است، حتماً مقدار را داخل کوتیشن قرار دهید.

### ویندوز – PowerShell
```powershell
# کوکی مستقیم
$env:MK_COOKIE = 'sessionid=...;'

# یا: مسیر فایل شامل کوکی
$env:MK_COOKIE_FILE = 'C:\\path\\to\\cookie.txt'
```

### ویندوز – CMD (Command Prompt)
```cmd
REM کوکی مستقیم
set "MK_COOKIE=sessionid=...;"

REM یا: مسیر فایل شامل کوکی
set "MK_COOKIE_FILE=C:\path\to\cookie.txt"
```

### لینوکس / مک – Bash/Zsh
```bash
# کوکی مستقیم
export MK_COOKIE='sessionid=...;'

# یا: مسیر فایل شامل کوکی
export MK_COOKIE_FILE="$HOME/cookie.txt"
```

نکته: اگر کوکی پیچیده یا چندخطی است، روش فایل (`MK_COOKIE_FILE`) توصیه می‌شود. البته در اینجا تک خطی است و همان تنظیم متغییر محیطی کفایت میکند.

## ▶️ اجرا
نمایش راهنما:
```powershell
node download.mjs --help 
```

اجرای دانلود:
```powershell
node download.mjs "https://maktabkhooneh.org/course/<slug>/" 
```

اجرای دانلود با آدرس فرمت جدید (LMS):
```powershell
node download.mjs "https://maktabkhooneh.org/lms/course/<slug>/unit/<unit_id>/" 
```

اجرای دانلود با ورود خودکار و ذخیره نشست:
```powershell
node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123" 
```

اجبار ورود مجدد:
```powershell
node download.mjs "https://maktabkhooneh.org/course/<slug>/" --user you@example.com --pass "Secret123" --force-login 
```

نکته: آدرس صفحه دوره‌ی مورد نظر را در دستورات فوق جایگزین کنید.

## 🧪 تست عملکرد
حالت نمونه‌گیری (مثلاً 64KB اول هر ویدیو):

```powershell
node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose
```

همچنین می‌توانید مقدار نمونه‌گیری را با متغیر محیطی ست کنید:
```powershell
$env:MK_SAMPLE_BYTES = "512000" 
node download.mjs "https://maktabkhooneh.org/course/<slug>/" 
```

## 📁 ساختار خروجی
همه فایل‌ها در زیر پوشه زیر دانلود و ذخیره خواهند شد:
```
download/<نام دوره>
```

## 🔒 نکات امنیتی
- فایل `session.json` حاوی کوکی فعال و اطلاعات لاگین شماست؛ هرگز آن را به اشتراک نگذارید.
- از قراردادن پسورد خام در تاریخچه شل خودداری کنید (می‌توانید از یک اسکریپت موقتی یا متغیر موقت استفاده کنید).

## 👤 نویسنده
- نویسنده/نگهدارنده: [NabiKAZ](https://github.com/NabiKAZ)
- توییتر (X): [https://x.com/NabiKAZ](https://x.com/NabiKAZ)
- تلگرام: [https://t.me/BotSorati](https://t.me/BotSorati)

## ⭐ حمایت و دونیت
اگر این پروژه برایتان مفید بود، لطفاً در گیت‌هاب به آن یک ⭐ ستاره بدهید. \
برای حمایت از توسعه‌های بعدی می‌توانید به کیف پول زیر، TON دونیت کنید: \
**TON Wallet:** `nabikaz.ton` \
حمایت شما باعث دلگرمی است.

## 📝 لایسنس
تحت مجوز GPL v3.0 – متن کامل در فایل [LICENSE](./LICENSE).

ساخته‌شده با ❤️ به کمک GPT-5
