'use strict';
/* Document labels in regional languages. Printed quotations show the local-language label with the English one underneath,
   so the English-speaking side of a deal can still read them. Text typed by you (items, terms, notes) is printed exactly as typed -
   type it in Tamil / Hindi / etc. if you want it in that language.
   NOTE: please have a native speaker of each language you use confirm these labels once. */
const LANGS = { '': 'English only', hi: 'हिन्दी (Hindi)', ta: 'தமிழ் (Tamil)', te: 'తెలుగు (Telugu)', kn: 'ಕನ್ನಡ (Kannada)', ml: 'മലയാളം (Malayalam)' };
const I18N = {
  hi: { 'QUOTATION': 'कोटेशन', 'Quote no.': 'कोटेशन संख्या', 'Revision': 'संशोधन', 'Date': 'दिनांक', 'Valid until': 'वैधता तिथि', 'Division': 'विभाग', 'Quotation for': 'इनके लिए कोटेशन', 'Project': 'परियोजना', 'Scope of work': 'कार्य का दायरा',
    'Description': 'विवरण', 'Unit': 'इकाई', 'Qty': 'मात्रा', 'Rate (₹)': 'दर (₹)', 'Amount (₹)': 'राशि (₹)', 'Subtotal': 'उप-योग', 'Discount': 'छूट', 'Taxable amount': 'कर योग्य राशि', 'Round off': 'पूर्णांक समायोजन', 'Grand total (₹)': 'कुल योग (₹)',
    'Payment schedule': 'भुगतान अनुसूची', 'Stage': 'चरण', 'Terms & conditions': 'नियम एवं शर्तें', 'Notes': 'टिप्पणियाँ', 'Bank details': 'बैंक विवरण', 'Client acceptance & date': 'ग्राहक की स्वीकृति एवं दिनांक', 'Authorised signatory': 'अधिकृत हस्ताक्षरकर्ता', 'For': 'के लिए',
    'Choose your option': 'अपना विकल्प चुनें', 'Option': 'विकल्प', 'Highlights': 'विशेषताएँ', 'Package (₹)': 'पैकेज (₹)', 'Quote total incl. GST (₹)': 'GST सहित कुल (₹)', 'Sub-total': 'उप-योग', 'Section total': 'खंड योग' },
  ta: { 'QUOTATION': 'விலைப்புள்ளி', 'Quote no.': 'விலைப்புள்ளி எண்', 'Revision': 'திருத்தம்', 'Date': 'தேதி', 'Valid until': 'செல்லுபடியாகும் தேதி', 'Division': 'பிரிவு', 'Quotation for': 'யாருக்கு', 'Project': 'திட்டம்', 'Scope of work': 'பணி வரம்பு',
    'Description': 'விவரம்', 'Unit': 'அலகு', 'Qty': 'அளவு', 'Rate (₹)': 'விலை (₹)', 'Amount (₹)': 'தொகை (₹)', 'Subtotal': 'துணை மொத்தம்', 'Discount': 'தள்ளுபடி', 'Taxable amount': 'வரிக்குட்பட்ட தொகை', 'Round off': 'முழுமையாக்கல்', 'Grand total (₹)': 'மொத்த தொகை (₹)',
    'Payment schedule': 'கட்டண அட்டவணை', 'Stage': 'நிலை', 'Terms & conditions': 'விதிமுறைகள் மற்றும் நிபந்தனைகள்', 'Notes': 'குறிப்புகள்', 'Bank details': 'வங்கி விவரங்கள்', 'Client acceptance & date': 'வாடிக்கையாளர் ஒப்புதல் & தேதி', 'Authorised signatory': 'அங்கீகரிக்கப்பட்ட கையொப்பதாரர்', 'For': 'சார்பாக',
    'Choose your option': 'உங்கள் தேர்வைத் தேர்ந்தெடுக்கவும்', 'Option': 'தேர்வு', 'Highlights': 'சிறப்பம்சங்கள்', 'Package (₹)': 'தொகுப்பு (₹)', 'Quote total incl. GST (₹)': 'GST உட்பட மொத்தம் (₹)', 'Sub-total': 'துணை மொத்தம்', 'Section total': 'பிரிவு மொத்தம்' },
  te: { 'QUOTATION': 'కొటేషన్', 'Quote no.': 'కొటేషన్ సంఖ్య', 'Revision': 'సవరణ', 'Date': 'తేదీ', 'Valid until': 'చెల్లుబాటు తేదీ', 'Division': 'విభాగం', 'Quotation for': 'ఎవరికి', 'Project': 'ప్రాజెక్ట్', 'Scope of work': 'పని పరిధి',
    'Description': 'వివరణ', 'Unit': 'యూనిట్', 'Qty': 'పరిమాణం', 'Rate (₹)': 'ధర (₹)', 'Amount (₹)': 'మొత్తం (₹)', 'Subtotal': 'ఉప మొత్తం', 'Discount': 'తగ్గింపు', 'Taxable amount': 'పన్ను వర్తించే మొత్తం', 'Round off': 'రౌండ్ ఆఫ్', 'Grand total (₹)': 'మొత్తం (₹)',
    'Payment schedule': 'చెల్లింపు షెడ్యూల్', 'Stage': 'దశ', 'Terms & conditions': 'నిబంధనలు మరియు షరతులు', 'Notes': 'గమనికలు', 'Bank details': 'బ్యాంకు వివరాలు', 'Client acceptance & date': 'కస్టమర్ ఆమోదం & తేదీ', 'Authorised signatory': 'అధీకృత సంతకందారు', 'For': 'తరఫున',
    'Choose your option': 'మీ ఎంపికను ఎంచుకోండి', 'Option': 'ఎంపిక', 'Highlights': 'ముఖ్యాంశాలు', 'Package (₹)': 'ప్యాకేజీ (₹)', 'Quote total incl. GST (₹)': 'GST తో కలిపి మొత్తం (₹)', 'Sub-total': 'ఉప మొత్తం', 'Section total': 'విభాగం మొత్తం' },
  kn: { 'QUOTATION': 'ಕೊಟೇಶನ್', 'Quote no.': 'ಕೊಟೇಶನ್ ಸಂಖ್ಯೆ', 'Revision': 'ಪರಿಷ್ಕರಣೆ', 'Date': 'ದಿನಾಂಕ', 'Valid until': 'ಮಾನ್ಯತೆಯ ದಿನಾಂಕ', 'Division': 'ವಿಭಾಗ', 'Quotation for': 'ಇವರಿಗೆ', 'Project': 'ಯೋಜನೆ', 'Scope of work': 'ಕೆಲಸದ ವ್ಯಾಪ್ತಿ',
    'Description': 'ವಿವರಣೆ', 'Unit': 'ಘಟಕ', 'Qty': 'ಪ್ರಮಾಣ', 'Rate (₹)': 'ದರ (₹)', 'Amount (₹)': 'ಮೊತ್ತ (₹)', 'Subtotal': 'ಉಪ ಮೊತ್ತ', 'Discount': 'ರಿಯಾಯಿತಿ', 'Taxable amount': 'ತೆರಿಗೆಗೆ ಒಳಪಡುವ ಮೊತ್ತ', 'Round off': 'ಸುತ್ತುವಿಕೆ', 'Grand total (₹)': 'ಒಟ್ಟು ಮೊತ್ತ (₹)',
    'Payment schedule': 'ಪಾವತಿ ವೇಳಾಪಟ್ಟಿ', 'Stage': 'ಹಂತ', 'Terms & conditions': 'ನಿಯಮಗಳು ಮತ್ತು ಷರತ್ತುಗಳು', 'Notes': 'ಟಿಪ್ಪಣಿಗಳು', 'Bank details': 'ಬ್ಯಾಂಕ್ ವಿವರಗಳು', 'Client acceptance & date': 'ಗ್ರಾಹಕರ ಒಪ್ಪಿಗೆ ಮತ್ತು ದಿನಾಂಕ', 'Authorised signatory': 'ಅಧಿಕೃತ ಸಹಿದಾರ', 'For': 'ಪರವಾಗಿ',
    'Choose your option': 'ನಿಮ್ಮ ಆಯ್ಕೆಯನ್ನು ಆರಿಸಿ', 'Option': 'ಆಯ್ಕೆ', 'Highlights': 'ವಿಶೇಷತೆಗಳು', 'Package (₹)': 'ಪ್ಯಾಕೇಜ್ (₹)', 'Quote total incl. GST (₹)': 'GST ಸೇರಿ ಒಟ್ಟು (₹)', 'Sub-total': 'ಉಪ ಮೊತ್ತ', 'Section total': 'ವಿಭಾಗದ ಮೊತ್ತ' },
  ml: { 'QUOTATION': 'ക്വട്ടേഷൻ', 'Quote no.': 'ക്വട്ടേഷൻ നമ്പർ', 'Revision': 'പുതുക്കൽ', 'Date': 'തീയതി', 'Valid until': 'സാധുതാ തീയതി', 'Division': 'വിഭാഗം', 'Quotation for': 'ആർക്ക്', 'Project': 'പ്രോജക്റ്റ്', 'Scope of work': 'ജോലിയുടെ പരിധി',
    'Description': 'വിവരണം', 'Unit': 'യൂണിറ്റ്', 'Qty': 'അളവ്', 'Rate (₹)': 'നിരക്ക് (₹)', 'Amount (₹)': 'തുക (₹)', 'Subtotal': 'ഉപമൊത്തം', 'Discount': 'കിഴിവ്', 'Taxable amount': 'നികുതി വിധേയ തുക', 'Round off': 'റൗണ്ട് ഓഫ്', 'Grand total (₹)': 'ആകെ തുക (₹)',
    'Payment schedule': 'പേയ്‌മെന്റ് ഷെഡ്യൂൾ', 'Stage': 'ഘട്ടം', 'Terms & conditions': 'നിബന്ധനകളും വ്യവസ്ഥകളും', 'Notes': 'കുറിപ്പുകൾ', 'Bank details': 'ബാങ്ക് വിവരങ്ങൾ', 'Client acceptance & date': 'ഉപഭോക്താവിന്റെ സമ്മതം & തീയതി', 'Authorised signatory': 'അധികാരപ്പെടുത്തിയ ഒപ്പിടുന്നയാൾ', 'For': 'വേണ്ടി',
    'Choose your option': 'നിങ്ങളുടെ ഓപ്ഷൻ തിരഞ്ഞെടുക്കുക', 'Option': 'ഓപ്ഷൻ', 'Highlights': 'സവിശേഷതകൾ', 'Package (₹)': 'പാക്കേജ് (₹)', 'Quote total incl. GST (₹)': 'GST ഉൾപ്പെടെ ആകെ (₹)', 'Sub-total': 'ഉപമൊത്തം', 'Section total': 'വിഭാഗ ആകെ' },
};
/** Label for the printed document: local script on top, English below (or just English). `lang` is '' | hi | ta | te | kn | ml. */
function L(en, lang) {
  const t = lang && I18N[lang] && I18N[lang][en];
  return t ? `${esc(t)}<span class="en">${esc(en)}</span>` : esc(en);
}
